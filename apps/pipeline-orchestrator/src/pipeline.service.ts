import { EventBus } from '@brain/events';
import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';

// ─── Service URLs ───────────────────────────────────────────────────────────

const FEATURE_ENGINE_URL = process.env.FEATURE_ENGINE_URL ?? 'http://localhost:3004';
const AGENT_GATEWAY_URL = process.env.AGENT_GATEWAY_URL ?? 'http://localhost:3008';
const RISK_SERVICE_URL = process.env.RISK_SERVICE_URL ?? 'http://localhost:3005';
const EXECUTION_SERVICE_URL = process.env.EXECUTION_SERVICE_URL ?? 'http://localhost:3006';
const CONFIG_SERVICE_URL = process.env.CONFIG_SERVICE_URL ?? 'http://localhost:3007';

const PIPELINE_INTERVAL_MS = Number(process.env.PIPELINE_INTERVAL_MS) || 2_000;
const EXECUTION_MODE = (process.env.EXECUTION_MODE ?? 'paper') as 'paper' | 'live' | 'disabled';
const INITIAL_BALANCE_USD = Number(process.env.INITIAL_BALANCE_USD) || 100;

// ─── Pipeline state ─────────────────────────────────────────────────────────

interface PipelineCycleResult {
  cycle: number;
  timestamp: string;
  stage: 'skipped' | 'no_features' | 'not_tradeable' | 'agent_hold' | 'risk_rejected' | 'executed' | 'error';
  details: Record<string, unknown>;
  durationMs: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- HTTP responses are loosely typed
type ServiceResponse = any;

@Injectable()
export class PipelineService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PipelineService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private enabled = true;
  private cycleCount = 0;
  private lastResult: PipelineCycleResult | null = null;
  private lastWindowId: string | null = null;
  private lastTradeWindowId: string | null = null;

  constructor(private readonly eventBus: EventBus) {}

  onModuleInit(): void {
    if (EXECUTION_MODE === 'disabled') {
      this.logger.warn('Pipeline disabled (EXECUTION_MODE=disabled)');
      this.enabled = false;
      return;
    }
    this.startLoop();
  }

  onModuleDestroy(): void {
    this.stopLoop();
  }

  // ─── Public API ──────────────────────────────────────────────────────────────

  getStatus(): Record<string, unknown> {
    return {
      enabled: this.enabled,
      running: this.running,
      executionMode: EXECUTION_MODE,
      cycleCount: this.cycleCount,
      intervalMs: PIPELINE_INTERVAL_MS,
      lastResult: this.lastResult,
      serviceUrls: {
        featureEngine: FEATURE_ENGINE_URL,
        agentGateway: AGENT_GATEWAY_URL,
        riskService: RISK_SERVICE_URL,
        executionService: EXECUTION_SERVICE_URL,
      },
    };
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (enabled && !this.timer) {
      this.startLoop();
    } else if (!enabled) {
      this.stopLoop();
    }
  }

  async triggerOnce(): Promise<PipelineCycleResult> {
    return this.runCycle();
  }

  // ─── Pipeline Loop ────────────────────────────────────────────────────────────

  private startLoop(): void {
    this.logger.log(`Starting pipeline loop (interval=${PIPELINE_INTERVAL_MS}ms, mode=${EXECUTION_MODE})`);
    this.timer = setInterval(async () => {
      if (!this.enabled || this.running) return;
      try {
        await this.runCycle();
      } catch (error) {
        this.logger.error('Pipeline cycle failed', (error as Error).stack);
      }
    }, PIPELINE_INTERVAL_MS);
  }

  private stopLoop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // ─── Dependency Health Check ───────────────────────────────────────────────────

  private async checkDependencyHealth(): Promise<{ ok: boolean; down: string[] }> {
    const dependencies: { name: string; url: string }[] = [
      { name: 'feature-engine', url: `${FEATURE_ENGINE_URL}/api/v1/features/health` },
      { name: 'agent-gateway', url: `${AGENT_GATEWAY_URL}/api/v1/agent/health` },
      { name: 'risk-service', url: `${RISK_SERVICE_URL}/api/v1/risk/health` },
      { name: 'execution-service', url: `${EXECUTION_SERVICE_URL}/api/v1/execution/health` },
    ];

    const results = await Promise.allSettled(
      dependencies.map(async (dep) => {
        const res = await fetch(dep.url, { signal: AbortSignal.timeout(2_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as { ok?: boolean };
        if (!json.ok) throw new Error('Health check returned ok=false');
        return dep.name;
      }),
    );

    const down: string[] = [];
    for (let i = 0; i < results.length; i++) {
      if (results[i].status === 'rejected') {
        down.push(dependencies[i].name);
      }
    }

    return { ok: down.length === 0, down };
  }

  // ─── Core Pipeline Cycle ──────────────────────────────────────────────────────

  private async runCycle(): Promise<PipelineCycleResult> {
    this.running = true;
    this.cycleCount++;
    const startMs = Date.now();
    const cycle = this.cycleCount;

    try {
      // 0a. Check trading hours
      const configData: ServiceResponse = await this.fetchJson(`${CONFIG_SERVICE_URL}/api/v1/config`);
      const tradingHours = configData?.trading?.tradingHoursUtc;
      if (tradingHours?.enabled) {
        const currentHourUtc = new Date().getUTCHours();
        const { startHour, endHour } = tradingHours;
        const outsideHours = startHour <= endHour
          ? (currentHourUtc < startHour || currentHourUtc >= endHour)
          : (currentHourUtc < startHour && currentHourUtc >= endHour); // overnight range e.g. 22-6
        if (outsideHours) {
          return this.finishCycle(cycle, startMs, 'skipped', {
            reason: 'Outside trading hours',
            currentHourUtc,
            allowedRange: `${startHour}:00-${endHour}:00 UTC`,
          });
        }
      }

      // 0b. Check dependency health
      const health = await this.checkDependencyHealth();
      if (!health.ok) {
        this.logger.warn(`Dependency health check failed: ${health.down.join(', ')}`);
        return this.finishCycle(cycle, startMs, 'error', {
          reason: 'Dependency health check failed',
          downServices: health.down,
        });
      }

      // 1. Fetch current features
      const features: ServiceResponse = await this.fetchJson(`${FEATURE_ENGINE_URL}/api/v1/features/current`);
      if (!features) {
        return this.finishCycle(cycle, startMs, 'no_features', { reason: 'Feature engine returned no data' });
      }

      const windowId: string = features.windowId ?? features.market?.windowId ?? 'unknown';
      this.lastWindowId = windowId;

      // Skip if not tradeable
      if (!features.signals?.tradeable) {
        return this.finishCycle(cycle, startMs, 'not_tradeable', {
          windowId,
          timeToCloseSec: features.market?.timeToCloseSec,
        });
      }

      // Skip if we already traded this window
      if (this.lastTradeWindowId === windowId) {
        return this.finishCycle(cycle, startMs, 'skipped', {
          windowId,
          reason: 'Already traded this window',
        });
      }

      // 2. Get risk state (needed for supervisor)
      const riskState: ServiceResponse = await this.fetchJson(`${RISK_SERVICE_URL}/api/v1/risk/state`);
      if (!riskState) {
        return this.finishCycle(cycle, startMs, 'error', { reason: 'Risk service unavailable' });
      }

      // 3. Call regime + edge agents in parallel
      const [regimeResult, edgeResult]: [ServiceResponse, ServiceResponse] = await Promise.all([
        this.postJson(`${AGENT_GATEWAY_URL}/api/v1/agent/regime/evaluate`, {
          windowId,
          features,
        }),
        this.postJson(`${AGENT_GATEWAY_URL}/api/v1/agent/edge/evaluate`, {
          windowId,
          features,
        }),
      ]);

      if (!regimeResult || !edgeResult) {
        return this.finishCycle(cycle, startMs, 'error', {
          windowId,
          reason: 'Agent evaluation failed',
          regimeOk: !!regimeResult,
          edgeOk: !!edgeResult,
        });
      }

      const regime: ServiceResponse = regimeResult.parsedOutput;
      const edge: ServiceResponse = edgeResult.parsedOutput;

      this.logger.log(
        `[${windowId}] Regime: ${regime.regime} (${regime.confidence}), Edge: ${edge.direction} mag=${edge.magnitude} conf=${edge.confidence}`,
      );

      // 4. Call supervisor agent
      const supervisorResult: ServiceResponse = await this.postJson(
        `${AGENT_GATEWAY_URL}/api/v1/agent/supervisor/evaluate`,
        {
          windowId,
          features,
          regime,
          edge,
          riskState: riskState.state,
          riskConfig: riskState.config,
        },
      );

      if (!supervisorResult) {
        return this.finishCycle(cycle, startMs, 'error', { windowId, reason: 'Supervisor evaluation failed' });
      }

      const decision: ServiceResponse = supervisorResult.parsedOutput;
      this.logger.log(
        `[${windowId}] Supervisor: ${decision.action} size=$${decision.sizeUsd} conf=${decision.confidence}`,
      );

      // Emit agent decision event
      this.eventBus.emit('agent.decision.made', {
        windowId,
        action: String(decision.action),
        sizeUsd: Number(decision.sizeUsd ?? 0),
        confidence: Number(decision.confidence),
      });

      // 5. If hold, stop here
      if (decision.action === 'hold') {
        return this.finishCycle(cycle, startMs, 'agent_hold', {
          windowId,
          regime: regime.regime,
          edge: edge.direction,
          reasoning: decision.reasoning,
        });
      }

      // 6. Send to risk evaluation
      const riskEval: ServiceResponse = await this.postJson(`${RISK_SERVICE_URL}/api/v1/risk/evaluate`, {
        windowId,
        agentDecisionId: supervisorResult.id,
        proposal: decision,
        features,
        balanceUsd: INITIAL_BALANCE_USD,
        openExposureUsd: riskState.state?.openPositionUsd ?? 0,
      });

      if (!riskEval || !riskEval.approved) {
        return this.finishCycle(cycle, startMs, 'risk_rejected', {
          windowId,
          action: decision.action,
          rejectionReasons: riskEval?.rejectionReasons ?? ['Risk service unavailable'],
        });
      }

      this.logger.log(`[${windowId}] Risk approved: $${riskEval.approvedSizeUsd}`);

      // 7. Execute trade
      const side = decision.action === 'buy_up' ? 'UP' : 'DOWN';
      const executionEndpoint =
        EXECUTION_MODE === 'live' ? 'live-order' : 'paper-order';

      const order: ServiceResponse = await this.postJson(
        `${EXECUTION_SERVICE_URL}/api/v1/execution/${executionEndpoint}`,
        {
          marketId: windowId,
          side,
          mode: EXECUTION_MODE,
          sizeUsd: riskEval.approvedSizeUsd,
          maxEntryPrice: side === 'UP' ? (features.book?.upAsk ?? 0.55) : (features.book?.downAsk ?? 0.55),
          mustExecuteBeforeSec: Math.max(((features.market?.timeToCloseSec as number) ?? 60) - 15, 5),
          source: 'pipeline-orchestrator',
          windowId,
          riskDecisionId: riskEval.id,
        },
      );

      if (!order) {
        return this.finishCycle(cycle, startMs, 'error', { windowId, reason: 'Execution failed' });
      }

      this.lastTradeWindowId = windowId;
      this.logger.log(
        `[${windowId}] Order executed: ${order.id} ${side} $${riskEval.approvedSizeUsd} (${EXECUTION_MODE})`,
      );

      return this.finishCycle(cycle, startMs, 'executed', {
        windowId,
        orderId: order.id,
        side,
        sizeUsd: riskEval.approvedSizeUsd,
        mode: EXECUTION_MODE,
        regime: regime.regime,
        edge: edge.direction,
        confidence: decision.confidence,
      });
    } catch (error) {
      return this.finishCycle(cycle, startMs, 'error', {
        message: (error as Error).message,
      });
    } finally {
      this.running = false;
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────────

  private finishCycle(
    cycle: number,
    startMs: number,
    stage: PipelineCycleResult['stage'],
    details: Record<string, unknown>,
  ): PipelineCycleResult {
    const result: PipelineCycleResult = {
      cycle,
      timestamp: new Date().toISOString(),
      stage,
      details,
      durationMs: Date.now() - startMs,
    };
    this.lastResult = result;

    if (stage === 'error') {
      this.logger.error(`Cycle #${cycle}: ${stage}`, JSON.stringify(details));
    } else if (stage === 'executed') {
      this.logger.log(`Cycle #${cycle}: TRADE EXECUTED in ${result.durationMs}ms`);
    }

    return result;
  }

  private async fetchJson(url: string): Promise<ServiceResponse | null> {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      if (!res.ok) return null;
      const json = (await res.json()) as { ok: boolean; data: unknown };
      return json.ok ? (json.data ?? null) : null;
    } catch {
      return null;
    }
  }

  private async postJson(url: string, body: unknown): Promise<ServiceResponse | null> {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) return null;
      const json = (await res.json()) as { ok: boolean; data: unknown };
      return json.ok ? (json.data ?? null) : null;
    } catch {
      return null;
    }
  }
}
