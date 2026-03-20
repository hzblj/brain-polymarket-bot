import { Injectable, OnModuleInit } from '@nestjs/common';
import type {
  RiskConfig,
  RiskState,
  UnixMs,
  FeaturePayload,
  SupervisorOutput,
} from '@brain/types';

// ─── Request / Response Types ────────────────────────────────────────────────

export interface RiskEvaluationRequest {
  windowId: string;
  agentDecisionId: string;
  proposal: SupervisorOutput;
  features: FeaturePayload;
  balanceUsd: number;
  openExposureUsd: number;
}

export interface RiskEvaluationResult {
  id: string;
  windowId: string;
  agentDecisionId: string;
  approved: boolean;
  approvedSizeUsd: number;
  rejectionReasons: string[];
  checksRun: RiskCheckResult[];
  evaluatedAt: string;
}

export interface RiskCheckResult {
  check: string;
  passed: boolean;
  reason: string | null;
}

export interface RiskConfigUpdate {
  maxSizeUsd?: number;
  dailyLossLimitUsd?: number;
  maxSpreadBps?: number;
  minDepthScore?: number;
  maxTradesPerWindow?: number;
  tradingEnabled?: boolean;
}

export interface FullRiskState {
  config: RiskConfig;
  state: RiskState;
  killSwitchActive: boolean;
  tradingEnabled: boolean;
  updatedAt: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const STALE_DATA_THRESHOLD_MS = 15_000;
const DEFAULT_CONFIG: RiskConfig = {
  maxSizeUsd: 50,
  dailyLossLimitUsd: 200,
  maxSpreadBps: 300,
  minDepthScore: 0.1,
  maxTradesPerWindow: 1,
};

@Injectable()
export class RiskService implements OnModuleInit {
  private config: RiskConfig = { ...DEFAULT_CONFIG };
  private killSwitchActive = false;
  private tradingEnabled = true;

  private dailyPnlUsd = 0;
  private openPositionUsd = 0;
  private tradesInCurrentWindow = 0;
  private currentWindowId: string | null = null;
  private lastTradeTime: UnixMs | null = null;

  // TODO: inject @brain/database, @brain/events, @brain/logger
  // constructor(
  //   private readonly database: DatabaseService,
  //   private readonly events: EventsService,
  //   private readonly logger: LoggerService,
  // ) {}

  async onModuleInit(): Promise<void> {
    // Load persisted config and daily P&L from database
    await this.loadDailyPnl();
    await this.loadPersistedConfig();
    console.log('[risk-service] initialized with config:', this.config);
  }

  // ─── Public API ──────────────────────────────────────────────────────────────

  /**
   * Returns the full risk state: config, current counters, kill switch status.
   */
  async getState(): Promise<FullRiskState> {
    await this.loadDailyPnl();

    return {
      config: { ...this.config },
      state: {
        dailyPnlUsd: this.dailyPnlUsd,
        openPositionUsd: this.openPositionUsd,
        tradesInWindow: this.tradesInCurrentWindow,
        lastTradeTime: this.lastTradeTime,
      },
      killSwitchActive: this.killSwitchActive,
      tradingEnabled: this.tradingEnabled,
      updatedAt: new Date().toISOString(),
    };
  }

  /**
   * Evaluates a proposed trade against all deterministic risk checks.
   * Returns approval/rejection with detailed reasons.
   */
  async evaluate(request: RiskEvaluationRequest): Promise<RiskEvaluationResult> {
    const { windowId, agentDecisionId, proposal, features } = request;

    // Reset per-window counter if window changed
    if (this.currentWindowId !== windowId) {
      this.currentWindowId = windowId;
      this.tradesInCurrentWindow = 0;
    }

    const checks: RiskCheckResult[] = [];
    const rejectionReasons: string[] = [];

    // 1. Kill switch check
    const killSwitchCheck = this.checkKillSwitch();
    checks.push(killSwitchCheck);
    if (!killSwitchCheck.passed) rejectionReasons.push(killSwitchCheck.reason!);

    // 2. Trading enabled check
    const tradingEnabledCheck = this.checkTradingEnabled();
    checks.push(tradingEnabledCheck);
    if (!tradingEnabledCheck.passed) rejectionReasons.push(tradingEnabledCheck.reason!);

    // 3. Max size per trade
    const sizeCheck = this.checkMaxSize(proposal.sizeUsd);
    checks.push(sizeCheck);
    if (!sizeCheck.passed) rejectionReasons.push(sizeCheck.reason!);

    // 4. Daily loss limit
    const dailyLossCheck = this.checkDailyLossLimit();
    checks.push(dailyLossCheck);
    if (!dailyLossCheck.passed) rejectionReasons.push(dailyLossCheck.reason!);

    // 5. Stale data detection
    const stalenessCheck = this.checkDataStaleness(features.eventTime);
    checks.push(stalenessCheck);
    if (!stalenessCheck.passed) rejectionReasons.push(stalenessCheck.reason!);

    // 6. Max spread
    const spreadCheck = this.checkMaxSpread(features.book.spreadBps);
    checks.push(spreadCheck);
    if (!spreadCheck.passed) rejectionReasons.push(spreadCheck.reason!);

    // 7. Min depth score
    const depthCheck = this.checkMinDepth(features.book.depthScore);
    checks.push(depthCheck);
    if (!depthCheck.passed) rejectionReasons.push(depthCheck.reason!);

    // 8. Max trades per window
    const windowTradeCheck = this.checkMaxTradesPerWindow();
    checks.push(windowTradeCheck);
    if (!windowTradeCheck.passed) rejectionReasons.push(windowTradeCheck.reason!);

    // 9. Balance sufficiency
    const balanceCheck = this.checkBalanceSufficiency(
      proposal.sizeUsd,
      request.balanceUsd,
      request.openExposureUsd,
    );
    checks.push(balanceCheck);
    if (!balanceCheck.passed) rejectionReasons.push(balanceCheck.reason!);

    const approved = rejectionReasons.length === 0 && proposal.action !== 'hold';
    const approvedSizeUsd = approved
      ? Math.min(proposal.sizeUsd, this.config.maxSizeUsd)
      : 0;

    // Track trade if approved
    if (approved) {
      this.tradesInCurrentWindow++;
      this.lastTradeTime = Date.now();
    }

    const result: RiskEvaluationResult = {
      id: this.generateId(),
      windowId,
      agentDecisionId,
      approved,
      approvedSizeUsd,
      rejectionReasons,
      checksRun: checks,
      evaluatedAt: new Date().toISOString(),
    };

    // Persist evaluation to database
    // await this.database.riskEvaluations.insert(result);

    // Emit event
    this.emitEvent(approved ? 'risk.approved' : 'risk.rejected', {
      windowId,
      agentDecisionId,
      approved,
      approvedSizeUsd,
      rejectionReasons,
    });

    return result;
  }

  /**
   * Activates or deactivates the kill switch.
   */
  async setKillSwitch(active: boolean): Promise<{ killSwitchActive: boolean; changedAt: string }> {
    const previous = this.killSwitchActive;
    this.killSwitchActive = active;

    if (previous !== active) {
      this.emitEvent('risk.kill-switch.changed', { active, previous });
      console.log(`[risk-service] Kill switch ${active ? 'ACTIVATED' : 'DEACTIVATED'}`);
    }

    // Persist kill switch state
    // await this.database.riskConfig.upsert({ killSwitchActive: active });

    return {
      killSwitchActive: this.killSwitchActive,
      changedAt: new Date().toISOString(),
    };
  }

  /**
   * Updates risk configuration limits.
   */
  async updateConfig(update: RiskConfigUpdate): Promise<RiskConfig & { tradingEnabled: boolean }> {
    if (update.maxSizeUsd !== undefined) this.config.maxSizeUsd = update.maxSizeUsd;
    if (update.dailyLossLimitUsd !== undefined) this.config.dailyLossLimitUsd = update.dailyLossLimitUsd;
    if (update.maxSpreadBps !== undefined) this.config.maxSpreadBps = update.maxSpreadBps;
    if (update.minDepthScore !== undefined) this.config.minDepthScore = update.minDepthScore;
    if (update.maxTradesPerWindow !== undefined) this.config.maxTradesPerWindow = update.maxTradesPerWindow;
    if (update.tradingEnabled !== undefined) this.tradingEnabled = update.tradingEnabled;

    // Persist to database
    // await this.database.riskConfig.upsert({ ...this.config, tradingEnabled: this.tradingEnabled });

    this.emitEvent('risk.config.updated', { config: this.config, tradingEnabled: this.tradingEnabled });
    console.log('[risk-service] Config updated:', this.config);

    return { ...this.config, tradingEnabled: this.tradingEnabled };
  }

  // ─── Individual Risk Checks ────────────────────────────────────────────────

  private checkKillSwitch(): RiskCheckResult {
    return {
      check: 'kill_switch',
      passed: !this.killSwitchActive,
      reason: this.killSwitchActive ? 'Kill switch is active — all trading halted' : null,
    };
  }

  private checkTradingEnabled(): RiskCheckResult {
    return {
      check: 'trading_enabled',
      passed: this.tradingEnabled,
      reason: this.tradingEnabled ? null : 'Trading is currently disabled',
    };
  }

  private checkMaxSize(proposedSizeUsd: number): RiskCheckResult {
    const passed = proposedSizeUsd <= this.config.maxSizeUsd;
    return {
      check: 'max_size',
      passed,
      reason: passed
        ? null
        : `Proposed size $${proposedSizeUsd} exceeds max $${this.config.maxSizeUsd}`,
    };
  }

  private checkDailyLossLimit(): RiskCheckResult {
    const remaining = this.config.dailyLossLimitUsd + this.dailyPnlUsd;
    const passed = remaining > 0;
    return {
      check: 'daily_loss_limit',
      passed,
      reason: passed
        ? null
        : `Daily loss limit reached: P&L $${this.dailyPnlUsd.toFixed(2)}, limit -$${this.config.dailyLossLimitUsd}`,
    };
  }

  private checkDataStaleness(eventTimeMs: number): RiskCheckResult {
    const ageMs = Date.now() - eventTimeMs;
    const passed = ageMs < STALE_DATA_THRESHOLD_MS;
    return {
      check: 'data_staleness',
      passed,
      reason: passed
        ? null
        : `Feature data is ${(ageMs / 1000).toFixed(1)}s old, threshold is ${STALE_DATA_THRESHOLD_MS / 1000}s`,
    };
  }

  private checkMaxSpread(spreadBps: number): RiskCheckResult {
    const passed = spreadBps <= this.config.maxSpreadBps;
    return {
      check: 'max_spread',
      passed,
      reason: passed
        ? null
        : `Spread ${spreadBps.toFixed(0)} bps exceeds max ${this.config.maxSpreadBps} bps`,
    };
  }

  private checkMinDepth(depthScore: number): RiskCheckResult {
    const passed = depthScore >= this.config.minDepthScore;
    return {
      check: 'min_depth',
      passed,
      reason: passed
        ? null
        : `Depth score ${depthScore.toFixed(3)} below minimum ${this.config.minDepthScore}`,
    };
  }

  private checkMaxTradesPerWindow(): RiskCheckResult {
    const passed = this.tradesInCurrentWindow < this.config.maxTradesPerWindow;
    return {
      check: 'max_trades_per_window',
      passed,
      reason: passed
        ? null
        : `Already executed ${this.tradesInCurrentWindow} trades this window (max ${this.config.maxTradesPerWindow})`,
    };
  }

  private checkBalanceSufficiency(
    proposedSizeUsd: number,
    balanceUsd: number,
    openExposureUsd: number,
  ): RiskCheckResult {
    const availableBalance = balanceUsd - openExposureUsd;
    const passed = proposedSizeUsd <= availableBalance;
    return {
      check: 'balance_sufficiency',
      passed,
      reason: passed
        ? null
        : `Proposed $${proposedSizeUsd} exceeds available balance $${availableBalance.toFixed(2)} (balance $${balanceUsd}, exposure $${openExposureUsd})`,
    };
  }

  // ─── Internal Helpers ──────────────────────────────────────────────────────

  private async loadDailyPnl(): Promise<void> {
    // TODO: Load from database
    // const today = new Date().toISOString().slice(0, 10);
    // const fills = await this.database.fills.findByDate(today);
    // this.dailyPnlUsd = fills.reduce((sum, f) => sum + f.pnlUsd, 0);
    // For now, keep in-memory value
  }

  private async loadPersistedConfig(): Promise<void> {
    // TODO: Load from database
    // const persisted = await this.database.riskConfig.findLatest();
    // if (persisted) {
    //   this.config = { ...this.config, ...persisted };
    //   this.killSwitchActive = persisted.killSwitchActive ?? false;
    //   this.tradingEnabled = persisted.tradingEnabled ?? true;
    // }
  }

  private emitEvent(event: string, payload: Record<string, unknown>): void {
    // TODO: Wire to @brain/events
    // this.events.emit(event, payload);
    console.log(`[risk-service] event: ${event}`, JSON.stringify(payload));
  }

  private generateId(): string {
    return `risk-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}
