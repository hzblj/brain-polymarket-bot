import { DATABASE_CLIENT, type DbClient, fills, riskConfigs, riskDecisions } from '@brain/database';
import { type BrainEventName, type BrainEventMap, EventBus } from '@brain/events';
import type { FeaturePayload, RiskConfig, RiskState, SupervisorOutput, UnixMs } from '@brain/types';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { desc, gte } from 'drizzle-orm';

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
  remainingDailyBudgetUsd: number;
  killSwitchActive: boolean;
  tradingEnabled: boolean;
  winStreak: number;
  streakMultiplier: number;
  updatedAt: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const STALE_DATA_THRESHOLD_MS = 30_000;
const DEFAULT_CONFIG: RiskConfig = {
  maxSizeUsd: 5,
  dailyLossLimitUsd: 25,
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
  private currentWinStreak = 0;

  constructor(
    @Inject(DATABASE_CLIENT) private readonly db: DbClient,
    @Inject(EventBus) private readonly eventBus: EventBus,
  ) {}

  async onModuleInit(): Promise<void> {
    // Load persisted config and daily P&L from database
    await this.loadDailyPnl();
    await this.loadPersistedConfig();
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
      remainingDailyBudgetUsd: this.remainingDailyBudgetUsd,
      killSwitchActive: this.killSwitchActive,
      tradingEnabled: this.tradingEnabled,
      winStreak: this.currentWinStreak,
      streakMultiplier: this.currentWinStreak >= 5 ? 2.0 : this.currentWinStreak >= 3 ? 1.5 : 1.0,
      updatedAt: new Date().toISOString(),
    };
  }

  /**
   * Evaluates a proposed trade against all deterministic risk checks.
   * Returns approval/rejection with detailed reasons.
   */
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: multi-check risk evaluation
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
    if (!killSwitchCheck.passed && killSwitchCheck.reason)
      rejectionReasons.push(killSwitchCheck.reason);

    // 2. Trading enabled check
    const tradingEnabledCheck = this.checkTradingEnabled();
    checks.push(tradingEnabledCheck);
    if (!tradingEnabledCheck.passed && tradingEnabledCheck.reason)
      rejectionReasons.push(tradingEnabledCheck.reason);

    // 3. Max size per trade
    const sizeCheck = this.checkMaxSize(proposal.sizeUsd);
    checks.push(sizeCheck);
    if (!sizeCheck.passed && sizeCheck.reason) rejectionReasons.push(sizeCheck.reason);

    // 4. Daily loss limit
    const dailyLossCheck = this.checkDailyLossLimit();
    checks.push(dailyLossCheck);
    if (!dailyLossCheck.passed && dailyLossCheck.reason)
      rejectionReasons.push(dailyLossCheck.reason);

    // 5. Stale data detection
    const stalenessCheck = this.checkDataStaleness(features.eventTime);
    checks.push(stalenessCheck);
    if (!stalenessCheck.passed && stalenessCheck.reason)
      rejectionReasons.push(stalenessCheck.reason);

    // 6. Max spread
    const spreadCheck = this.checkMaxSpread(features.book.spreadBps);
    checks.push(spreadCheck);
    if (!spreadCheck.passed && spreadCheck.reason) rejectionReasons.push(spreadCheck.reason);

    // 7. Min depth score
    const depthCheck = this.checkMinDepth(features.book.depthScore);
    checks.push(depthCheck);
    if (!depthCheck.passed && depthCheck.reason) rejectionReasons.push(depthCheck.reason);

    // 8. Max trades per window
    const windowTradeCheck = this.checkMaxTradesPerWindow();
    checks.push(windowTradeCheck);
    if (!windowTradeCheck.passed && windowTradeCheck.reason)
      rejectionReasons.push(windowTradeCheck.reason);

    // 9. Balance sufficiency
    const balanceCheck = this.checkBalanceSufficiency(
      proposal.sizeUsd,
      request.balanceUsd,
      request.openExposureUsd,
    );
    checks.push(balanceCheck);
    if (!balanceCheck.passed && balanceCheck.reason) rejectionReasons.push(balanceCheck.reason);

    const approved = rejectionReasons.length === 0 && proposal.action !== 'hold';
    // Win streak bonus: 3+ wins → 1.5x, 5+ wins → 2x max size
    const streakMultiplier = this.currentWinStreak >= 5 ? 2.0 : this.currentWinStreak >= 3 ? 1.5 : 1.0;
    const effectiveMaxSize = this.config.maxSizeUsd * streakMultiplier;
    // Cap approved size at the smallest of: proposed, effective max per trade, remaining daily budget
    const approvedSizeUsd = approved
      ? Math.min(proposal.sizeUsd, effectiveMaxSize, this.remainingDailyBudgetUsd)
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
    try {
      await this.db.insert(riskDecisions).values({
        id: result.id,
        windowId,
        agentDecisionId,
        approved,
        approvedSizeUsd,
        rejectionReasons,
        eventTime: Date.now(),
        processedAt: Date.now(),
      });
    } catch (_dbError) {
      /* ignored - persistence is best-effort */
    }

    // Emit event
    const riskPayload = { windowId, agentDecisionId, approved, approvedSizeUsd, rejectionReasons };
    if (approved) {
      this.emitEvent('risk.approved', riskPayload);
    } else {
      this.emitEvent('risk.rejected', riskPayload);
    }

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
    }

    // Persist kill switch state
    try {
      await this.db.insert(riskConfigs).values({
        config: this.config as unknown as Record<string, unknown>,
        killSwitchActive: this.killSwitchActive,
        tradingEnabled: this.tradingEnabled,
      });
    } catch (_dbError) {
      /* ignored - persistence is best-effort */
    }

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
    if (update.dailyLossLimitUsd !== undefined)
      this.config.dailyLossLimitUsd = update.dailyLossLimitUsd;
    if (update.maxSpreadBps !== undefined) this.config.maxSpreadBps = update.maxSpreadBps;
    if (update.minDepthScore !== undefined) this.config.minDepthScore = update.minDepthScore;
    if (update.maxTradesPerWindow !== undefined)
      this.config.maxTradesPerWindow = update.maxTradesPerWindow;
    if (update.tradingEnabled !== undefined) this.tradingEnabled = update.tradingEnabled;

    // Persist to database
    try {
      await this.db.insert(riskConfigs).values({
        config: this.config as unknown as Record<string, unknown>,
        killSwitchActive: this.killSwitchActive,
        tradingEnabled: this.tradingEnabled,
      });
    } catch (_dbError) {
      /* ignored - persistence is best-effort */
    }

    this.emitEvent('risk.config.updated', {
      config: this.config as unknown as Record<string, unknown>,
      tradingEnabled: this.tradingEnabled,
    });

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
    const streakMultiplier = this.currentWinStreak >= 5 ? 2.0 : this.currentWinStreak >= 3 ? 1.5 : 1.0;
    const effectiveMax = this.config.maxSizeUsd * streakMultiplier;
    const passed = proposedSizeUsd <= effectiveMax;
    return {
      check: 'max_size',
      passed,
      reason: passed
        ? null
        : `Proposed size $${proposedSizeUsd} exceeds max $${effectiveMax}${streakMultiplier > 1 ? ` (base $${this.config.maxSizeUsd} × ${streakMultiplier} streak bonus)` : ''}`,
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
        : `Daily budget exhausted: P&L $${this.dailyPnlUsd.toFixed(2)}, budget $${this.config.dailyLossLimitUsd}. Winnings were reinvested but net losses hit the limit.`,
    };
  }

  /**
   * Returns how much of the daily budget remains.
   * Budget = dailyLossLimitUsd. Winnings are reinvested (increase remaining),
   * losses reduce it. When remaining <= 0, trading stops for the day.
   */
  get remainingDailyBudgetUsd(): number {
    return Math.max(0, this.config.dailyLossLimitUsd + this.dailyPnlUsd);
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
    // Fetch resolved orders from execution service for real P&L
    try {
      const LOCAL_HOST = process.env.LOCAL_IP ?? 'localhost';
      const EXECUTION_URL = process.env.EXECUTION_SERVICE_URL ?? `http://${LOCAL_HOST}:3006`;
      const res = await fetch(`${EXECUTION_URL}/api/v1/execution/resolved?limit=100`, {
        signal: AbortSignal.timeout(3_000),
      });
      if (!res.ok) return;
      const json = (await res.json()) as { ok: boolean; data: Array<{ pnlUsd: number; resolvedAt: string }> };
      if (!json.ok || !Array.isArray(json.data)) return;

      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const todayTrades = json.data.filter(
        (t) => new Date(t.resolvedAt).getTime() >= todayStart.getTime(),
      );
      this.dailyPnlUsd = todayTrades.reduce((sum, t) => sum + (t.pnlUsd ?? 0), 0);

      // Compute current win streak from most recent trades (across all days)
      let streak = 0;
      for (const t of json.data) {
        if ((t.pnlUsd ?? 0) > 0) streak++;
        else break;
      }
      this.currentWinStreak = streak;
    } catch {
      // Keep in-memory value
    }
  }

  private async loadPersistedConfig(): Promise<void> {
    try {
      const rows = await this.db
        .select()
        .from(riskConfigs)
        .orderBy(desc(riskConfigs.updatedAt))
        .limit(1);
      const [persisted] = rows;
      if (persisted) {
        const storedConfig = persisted.config as Record<string, unknown>;
        this.config = { ...this.config, ...storedConfig } as RiskConfig;
        this.killSwitchActive = persisted.killSwitchActive;
        this.tradingEnabled = persisted.tradingEnabled;
      }
    } catch (_error) {
      /* ignored - fall back to defaults */
    }
  }

  private emitEvent<E extends BrainEventName>(event: E, payload: BrainEventMap[E]): void {
    this.eventBus.emit(event, payload);
  }

  private generateId(): string {
    return `risk-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}
