import { EventBus } from '@brain/events';
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';

// ─── Service URLs ───────────────────────────────────────────────────────────

const LOCAL_HOST = process.env.LOCAL_IP ?? 'localhost';
const FEATURE_ENGINE_URL = process.env.FEATURE_ENGINE_URL ?? `http://${LOCAL_HOST}:3004`;
const AGENT_GATEWAY_URL = process.env.AGENT_GATEWAY_URL ?? `http://${LOCAL_HOST}:3008`;
const RISK_SERVICE_URL = process.env.RISK_SERVICE_URL ?? `http://${LOCAL_HOST}:3005`;
const EXECUTION_SERVICE_URL = process.env.EXECUTION_SERVICE_URL ?? `http://${LOCAL_HOST}:3006`;
const CONFIG_SERVICE_URL = process.env.CONFIG_SERVICE_URL ?? `http://${LOCAL_HOST}:3007`;
const MARKET_SERVICE_URL = process.env.MARKET_SERVICE_URL ?? `http://${LOCAL_HOST}:3001`;

const PIPELINE_INTERVAL_MS = Number(process.env.PIPELINE_INTERVAL_MS) || 2_000;
const INITIAL_BALANCE_USD = Number(process.env.INITIAL_BALANCE_USD) || 100;
const PRE_COMPUTE_LEAD_TIME_SEC = Number(process.env.PRE_COMPUTE_LEAD_TIME_SEC) || 90;
const WINDOW_DURATION_SEC = 300; // 5 minutes

// ─── Pipeline state ─────────────────────────────────────────────────────────

interface PipelineCycleResult {
  cycle: number;
  timestamp: string;
  stage:
    | 'skipped'
    | 'no_features'
    | 'not_tradeable'
    | 'agent_hold'
    | 'risk_rejected'
    | 'executed'
    | 'error'
    | 'precomputed'
    | 'gatekeeper_validated'
    | 'gatekeeper_invalidated'
    | 'validator_rejected'
    | 'strategy_filtered';
  details: Record<string, unknown>;
  durationMs: number;
}

interface PreComputedDecision {
  targetWindowSlug: string;
  targetWindowStartSec: number;
  regime: ServiceResponse;
  edge: ServiceResponse;
  supervisorResult: ServiceResponse;
  decision: ServiceResponse;
  features: ServiceResponse;
  riskState: ServiceResponse;
  agentProfile: ServiceResponse;
  computedAt: number;
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

  // Pre-computation state
  private preComputedDecision: PreComputedDecision | null = null;
  private preComputingForWindow: string | null = null;
  private gatekeeperRanForWindow: string | null = null;

  // Throttle: avoid re-evaluating same window too fast after routing no-match
  private lastRoutingNoMatchWindow: string | null = null;
  private lastRoutingNoMatchTime = 0;

  // Dedup: track windows currently being evaluated in reactive pipeline
  private reactiveEvaluatingWindow: string | null = null;

  constructor(@Inject(EventBus) private readonly eventBus: EventBus) {}

  onModuleInit(): void {
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
      executionMode: 'dynamic (from config-service)',
      cycleCount: this.cycleCount,
      intervalMs: PIPELINE_INTERVAL_MS,
      lastResult: this.lastResult,
      preComputedDecision: this.preComputedDecision
        ? {
            targetWindowSlug: this.preComputedDecision.targetWindowSlug,
            action: this.preComputedDecision.decision?.action,
            confidence: this.preComputedDecision.decision?.confidence,
            computedAt: new Date(this.preComputedDecision.computedAt).toISOString(),
          }
        : null,
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
    if (this.running) {
      return { cycle: this.cycleCount, timestamp: new Date().toISOString(), stage: 'skipped', details: { reason: 'Cycle already running' }, durationMs: 0 };
    }
    return this.runCycle();
  }

  // ─── Pipeline Loop ────────────────────────────────────────────────────────────

  private startLoop(): void {
    this.logger.log(`Starting pipeline loop (interval=${PIPELINE_INTERVAL_MS}ms, mode=dynamic, preComputeLead=${PRE_COMPUTE_LEAD_TIME_SEC}s)`);
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
      const r = results[i];
      if (r && r.status === 'rejected') {
        down.push(dependencies[i]!.name);
      }
    }

    return { ok: down.length === 0, down };
  }

  // ─── Window Timing ───────────────────────────────────────────────────────────

  private getWindowTiming(): { currentWindowStartSec: number; nextWindowStartSec: number; secondsToNextWindow: number; nextWindowSlug: string; currentWindowSlug: string } {
    const nowSec = Math.floor(Date.now() / 1000);
    const currentWindowStartSec = Math.floor(nowSec / WINDOW_DURATION_SEC) * WINDOW_DURATION_SEC;
    const nextWindowStartSec = currentWindowStartSec + WINDOW_DURATION_SEC;
    const secondsToNextWindow = nextWindowStartSec - nowSec;
    return {
      currentWindowStartSec,
      nextWindowStartSec,
      secondsToNextWindow,
      nextWindowSlug: `btc-updown-5m-${nextWindowStartSec}`,
      currentWindowSlug: `btc-updown-5m-${currentWindowStartSec}`,
    };
  }

  // ─── Core Pipeline Cycle ──────────────────────────────────────────────────────

  private async runCycle(): Promise<PipelineCycleResult> {
    this.running = true;
    this.cycleCount++;
    const startMs = Date.now();
    const cycle = this.cycleCount;

    try {
      // 0a. Fetch config and check trading mode
      const configData: ServiceResponse = await this.fetchJson(`${CONFIG_SERVICE_URL}/api/v1/config`);
      let executionMode: string = configData?.trading?.mode ?? 'disabled';
      if (executionMode === 'disabled') {
        return this.finishCycle(cycle, startMs, 'skipped', { reason: 'Trading mode is disabled' });
      }

      // 0b. Check trading hours
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

      // 0c. Check dependency health + fetch all active strategies in parallel
      const [health, allStrategiesRaw]: [{ ok: boolean; down: string[] }, ServiceResponse | null] = await Promise.all([
        this.checkDependencyHealth(),
        this.fetchJson(`${CONFIG_SERVICE_URL}/api/v1/config/strategies/active`).catch(() => null),
      ]);
      if (!health.ok) {
        this.logger.warn(`Dependency health check failed: ${health.down.join(', ')}`);
        return this.finishCycle(cycle, startMs, 'error', {
          reason: 'Dependency health check failed',
          downServices: health.down,
        });
      }

      const allStrategies: ServiceResponse[] = Array.isArray(allStrategiesRaw) ? allStrategiesRaw
        : Array.isArray(allStrategiesRaw?.data) ? allStrategiesRaw.data
        : [];

      if (allStrategies.length === 0) {
        this.logger.warn('No active strategies found — routing will fail');
      } else {
        this.logger.debug(`Loaded ${allStrategies.length} active strategies: ${allStrategies.map((s: ServiceResponse) => s.strategyKey).join(', ')}`);
      }

      // ─── Window timing & cache cleanup ───────────────────────────────────────
      const timing = this.getWindowTiming();

      // Clear stale state when window changes
      if (this.preComputedDecision) {
        const targetEndSec = this.preComputedDecision.targetWindowStartSec + WINDOW_DURATION_SEC;
        if (Math.floor(Date.now() / 1000) > targetEndSec) {
          this.preComputedDecision = null;
          this.preComputingForWindow = null;
          this.gatekeeperRanForWindow = null;
        }
      }
      // Also clear pre-compute tracking when window has passed
      if (this.preComputingForWindow && this.preComputingForWindow !== timing.nextWindowSlug && this.preComputingForWindow !== timing.currentWindowSlug) {
        this.preComputingForWindow = null;
      }

      // ─── BRANCH A: Pre-compute for upcoming window ─────────────────────────
      const shouldPreCompute =
        timing.secondsToNextWindow <= PRE_COMPUTE_LEAD_TIME_SEC &&
        timing.secondsToNextWindow > 5 &&
        this.preComputingForWindow !== timing.nextWindowSlug &&
        this.preComputedDecision?.targetWindowSlug !== timing.nextWindowSlug;

      if (shouldPreCompute) {
        return this.runPreCompute(cycle, startMs, timing.nextWindowSlug, timing.nextWindowStartSec, executionMode, configData, allStrategies);
      }

      // ─── BRANCH B: Gatekeeper for current window ──────────────────────────
      const hasPreComputedForCurrentWindow =
        this.preComputedDecision?.targetWindowSlug === timing.currentWindowSlug;
      const gatekeeperNotYetRun = this.gatekeeperRanForWindow !== timing.currentWindowSlug;

      if (hasPreComputedForCurrentWindow && gatekeeperNotYetRun) {
        return this.runGatekeeper(cycle, startMs, timing.currentWindowSlug, executionMode);
      }

      // ─── No reactive fallback — only trade via pre-compute + gatekeeper ───
      return this.finishCycle(cycle, startMs, 'skipped', { reason: 'Waiting for pre-compute window' });
    } catch (error) {
      return this.finishCycle(cycle, startMs, 'error', {
        message: (error as Error).message,
      });
    } finally {
      this.running = false;
    }
  }

  // ─── Branch A: Pre-Compute ──────────────────────────────────────────────────

  private async runPreCompute(
    cycle: number,
    startMs: number,
    nextWindowSlug: string,
    nextWindowStartSec: number,
    _executionMode: string,
    configData: ServiceResponse,
    allStrategies: ServiceResponse[],
  ): Promise<PipelineCycleResult> {
    this.preComputingForWindow = nextWindowSlug;
    this.logger.log(`Pre-computing for window ${nextWindowSlug} (starts in ${nextWindowStartSec - Math.floor(Date.now() / 1000)}s)`);

    const features: ServiceResponse = await this.fetchJson(`${FEATURE_ENGINE_URL}/api/v1/features/current`);
    if (!features) {
      this.preComputingForWindow = null;
      return this.finishCycle(cycle, startMs, 'no_features', { reason: 'Feature engine returned no data (pre-compute)' });
    }

    const riskState: ServiceResponse = await this.fetchJson(`${RISK_SERVICE_URL}/api/v1/risk/state`);
    if (!riskState) {
      this.preComputingForWindow = null;
      return this.finishCycle(cycle, startMs, 'error', { reason: 'Risk service unavailable (pre-compute)' });
    }

    const windowId = nextWindowSlug;

    // Step 1: Call regime agent first (shared across strategies)
    const regimeResult: ServiceResponse = await this.postJson(`${AGENT_GATEWAY_URL}/api/v1/agent/regime/evaluate`, {
      windowId,
      features,
    });

    if (!regimeResult) {
      this.preComputingForWindow = null;
      return this.finishCycle(cycle, startMs, 'error', { windowId, reason: 'Regime evaluation failed (pre-compute)' });
    }

    const regime = regimeResult.parsedOutput;
    this.logger.log(`[pre-compute:${windowId}] Regime: ${regime.regime} (${regime.confidence})`);

    // Step 2: Route to strategy based on regime
    const selectedStrategy = this.routeToStrategy(allStrategies, regime.regime);
    if (!selectedStrategy) {
      // Don't store a hold decision — let reactive pipeline retry with fresh data when window opens
      // But keep preComputingForWindow set so pre-compute doesn't spam
      return this.finishCycle(cycle, startMs, 'agent_hold', {
        windowId,
        regime: regime.regime,
        reason: `No strategy matches regime '${regime.regime}'`,
      });
    }

    this.logger.log(`[pre-compute:${windowId}] Routed to strategy: ${selectedStrategy.strategyKey}`);

    // Sync risk profile for selected strategy
    if (selectedStrategy.riskProfile) {
      await this.postJson(`${RISK_SERVICE_URL}/api/v1/risk/config`, selectedStrategy.riskProfile).catch(() => null);
    }

    const agentProfile = selectedStrategy.agentProfile;

    // Step 3: Call edge agent with strategy-specific profile
    const edgeResult: ServiceResponse = await this.postJson(`${AGENT_GATEWAY_URL}/api/v1/agent/edge/evaluate`, {
      windowId,
      features,
      agentProfile: agentProfile?.edgeAgentProfile,
    });

    if (!edgeResult) {
      this.preComputingForWindow = null;
      return this.finishCycle(cycle, startMs, 'error', { windowId, reason: 'Edge evaluation failed (pre-compute)' });
    }

    const edge = edgeResult.parsedOutput;
    this.logger.log(
      `[pre-compute:${windowId}] Edge: ${edge.direction} mag=${edge.magnitude} conf=${edge.confidence}`,
    );

    // Step 4: Call supervisor agent with strategy-specific profile
    const supervisorResult: ServiceResponse = await this.postJson(
      `${AGENT_GATEWAY_URL}/api/v1/agent/supervisor/evaluate`,
      {
        windowId,
        features,
        regime,
        edge,
        riskState: riskState.state,
        riskConfig: riskState.config,
        agentProfile: agentProfile?.supervisorAgentProfile,
      },
    );

    if (!supervisorResult) {
      this.preComputingForWindow = null;
      return this.finishCycle(cycle, startMs, 'error', { windowId, reason: 'Supervisor evaluation failed (pre-compute)' });
    }

    const decision = supervisorResult.parsedOutput;
    this.logger.log(
      `[pre-compute:${windowId}] Supervisor: ${decision.action} size=$${decision.sizeUsd} conf=${decision.confidence}`,
    );

    // Post-filter: enforce minConfidence from selected strategy
    const minConfidence = selectedStrategy.decisionPolicy?.minConfidence;
    if (minConfidence && decision.action !== 'hold' && decision.confidence < minConfidence) {
      this.logger.log(`[pre-compute:${windowId}] Confidence ${decision.confidence} below strategy minimum ${minConfidence}, forcing hold`);
      decision.action = 'hold';
      decision.sizeUsd = 0;
    }

    // Cache the pre-computed decision
    this.preComputedDecision = {
      targetWindowSlug: nextWindowSlug,
      targetWindowStartSec: nextWindowStartSec,
      regime,
      edge,
      supervisorResult,
      decision,
      features,
      riskState,
      agentProfile,
      computedAt: Date.now(),
    };

    this.eventBus.emit('pipeline.precomputed', {
      targetWindowSlug: nextWindowSlug,
      action: String(decision.action),
      sizeUsd: Number(decision.sizeUsd ?? 0),
      confidence: Number(decision.confidence),
      durationMs: Date.now() - startMs,
    });

    return this.finishCycle(cycle, startMs, 'precomputed', {
      windowId: nextWindowSlug,
      action: decision.action,
      sizeUsd: decision.sizeUsd,
      confidence: decision.confidence,
      durationMs: Date.now() - startMs,
    });
  }

  // ─── Branch B: Gatekeeper ───────────────────────────────────────────────────

  private async runGatekeeper(
    cycle: number,
    startMs: number,
    currentWindowSlug: string,
    executionMode: string,
  ): Promise<PipelineCycleResult> {
    const preComputed = this.preComputedDecision!;
    const decision = preComputed.decision;
    const windowId = currentWindowSlug;

    // Mark gatekeeper as running for this window
    this.gatekeeperRanForWindow = currentWindowSlug;
    this.lastTradeWindowId = currentWindowSlug;

    // If pre-computed decision was hold, skip gatekeeper entirely
    if (decision.action === 'hold') {
      this.logger.log(`[gatekeeper:${windowId}] Pre-computed decision was HOLD, skipping gatekeeper`);

      this.eventBus.emit('agent.decision.made', {
        windowId,
        action: 'hold',
        sizeUsd: 0,
        confidence: Number(decision.confidence),
      });

      return this.finishCycle(cycle, startMs, 'agent_hold', {
        windowId,
        regime: preComputed.regime?.regime,
        edge: preComputed.edge?.direction,
        reasoning: decision.reasoning,
        source: 'precomputed',
      });
    }

    // Fetch FRESH features
    const freshFeatures: ServiceResponse = await this.fetchJson(`${FEATURE_ENGINE_URL}/api/v1/features/current`);
    if (!freshFeatures) {
      return this.finishCycle(cycle, startMs, 'no_features', { reason: 'Feature engine returned no data (gatekeeper)' });
    }

    // Step 1: Nano validator (~100-200ms) — check fresh features sanity
    const validatorResult: ServiceResponse = await this.postJson(
      `${AGENT_GATEWAY_URL}/api/v1/agent/validator/evaluate`,
      { windowId, features: freshFeatures },
    );

    if (validatorResult?.parsedOutput && !validatorResult.parsedOutput.valid) {
      const issues: string[] = validatorResult.parsedOutput.issues ?? [];
      this.logger.warn(`[gatekeeper:${windowId}] Nano validator REJECTED: ${issues.join(', ')}`);

      this.eventBus.emit('validator.rejected', { windowId, issues });

      return this.finishCycle(cycle, startMs, 'validator_rejected', {
        windowId,
        issues,
        source: 'validator',
      });
    }

    // Step 2: Gatekeeper (~1-2s) — compare pre-computed decision vs fresh data
    const preComputeFeaturesSummary = {
      returnBps: preComputed.features?.price?.returnBps ?? 0,
      spreadBps: preComputed.features?.book?.spreadBps ?? 0,
      depthScore: preComputed.features?.book?.depthScore ?? 0,
      currentPrice: preComputed.features?.price?.currentPrice ?? 0,
      volatility: preComputed.features?.price?.volatility ?? 0,
    };

    const timeElapsedSec = Math.floor((Date.now() - preComputed.computedAt) / 1000);

    const gatekeeperResult: ServiceResponse = await this.postJson(
      `${AGENT_GATEWAY_URL}/api/v1/agent/gatekeeper/evaluate`,
      {
        windowId,
        freshFeatures,
        preComputedDecision: decision,
        preComputeFeaturesSummary,
        timeElapsedSec,
      },
    );

    if (!gatekeeperResult?.parsedOutput) {
      // Gatekeeper failed — fall through to execute anyway (fail-open for speed)
      this.logger.warn(`[gatekeeper:${windowId}] Gatekeeper call failed, proceeding with pre-computed decision`);
    } else if (!gatekeeperResult.parsedOutput.validated) {
      const reasoning: string = gatekeeperResult.parsedOutput.reasoning ?? 'unknown';
      this.logger.log(`[gatekeeper:${windowId}] INVALIDATED: ${reasoning}`);

      this.eventBus.emit('gatekeeper.invalidated', { windowId, reasoning });

      return this.finishCycle(cycle, startMs, 'gatekeeper_invalidated', {
        windowId,
        action: decision.action,
        reasoning,
        source: 'gatekeeper',
      });
    } else {
      const reasoning: string = gatekeeperResult.parsedOutput.reasoning ?? '';
      this.logger.log(`[gatekeeper:${windowId}] VALIDATED: ${reasoning}`);

      // Apply size adjustment if gatekeeper suggested one
      if (gatekeeperResult.parsedOutput.adjustedSizeUsd != null) {
        decision.sizeUsd = gatekeeperResult.parsedOutput.adjustedSizeUsd;
      }

      this.eventBus.emit('gatekeeper.validated', {
        windowId,
        adjustedSizeUsd: gatekeeperResult.parsedOutput.adjustedSizeUsd,
        reasoning,
      });
    }

    // Emit agent decision event
    this.eventBus.emit('agent.decision.made', {
      windowId,
      action: String(decision.action),
      sizeUsd: Number(decision.sizeUsd ?? 0),
      confidence: Number(decision.confidence),
    });

    // Proceed to risk evaluation + execution using fresh features
    return this.executeAfterApproval(cycle, startMs, windowId, decision, preComputed.supervisorResult, freshFeatures, executionMode);
  }

  // ─── Branch C: Fallback Reactive Pipeline ───────────────────────────────────

  private async runReactivePipeline(
    cycle: number,
    startMs: number,
    executionMode: string,
    configData: ServiceResponse,
    allStrategies: ServiceResponse[],
  ): Promise<PipelineCycleResult> {
    // 1. Fetch current features
    const features: ServiceResponse = await this.fetchJson(`${FEATURE_ENGINE_URL}/api/v1/features/current`);
    if (!features) {
      return this.finishCycle(cycle, startMs, 'no_features', { reason: 'Feature engine returned no data' });
    }

    const windowId: string = features.windowId ?? features.market?.windowId ?? 'unknown';
    this.lastWindowId = windowId;

    if (!features.signals?.tradeable) {
      return this.finishCycle(cycle, startMs, 'not_tradeable', {
        windowId,
        timeToCloseSec: features.market?.timeToCloseSec,
      });
    }

    if (this.lastTradeWindowId === windowId) {
      return this.finishCycle(cycle, startMs, 'skipped', {
        windowId,
        reason: 'Already evaluated this window',
      });
    }

    // Throttle: if routing failed for this window in the reactive pipeline, wait 60s before retrying
    if (this.lastRoutingNoMatchWindow === windowId && Date.now() - this.lastRoutingNoMatchTime < 60_000) {
      return this.finishCycle(cycle, startMs, 'skipped', {
        windowId,
        reason: 'Routing no-match cooldown',
      });
    }

    // Dedup: prevent parallel reactive evaluations for the same window
    if (this.reactiveEvaluatingWindow === windowId) {
      return this.finishCycle(cycle, startMs, 'skipped', {
        windowId,
        reason: 'Reactive evaluation already in progress for this window',
      });
    }
    this.reactiveEvaluatingWindow = windowId;

    // 2. Get risk state
    const riskState: ServiceResponse = await this.fetchJson(`${RISK_SERVICE_URL}/api/v1/risk/state`);
    if (!riskState) {
      this.reactiveEvaluatingWindow = null;
      return this.finishCycle(cycle, startMs, 'error', { reason: 'Risk service unavailable' });
    }

    // 3. Call regime agent first (shared across strategies)
    const regimeResult: ServiceResponse = await this.postJson(`${AGENT_GATEWAY_URL}/api/v1/agent/regime/evaluate`, {
      windowId,
      features,
    });

    if (!regimeResult) {
      this.reactiveEvaluatingWindow = null;
      return this.finishCycle(cycle, startMs, 'error', { windowId, reason: 'Regime evaluation failed' });
    }

    const regime: ServiceResponse = regimeResult.parsedOutput;
    this.logger.log(`[${windowId}] Regime: ${regime.regime} (${regime.confidence})`);

    // 4. Route to strategy based on regime
    const selectedStrategy = this.routeToStrategy(allStrategies, regime.regime);
    if (!selectedStrategy) {
      // Do NOT set lastTradeWindowId — regime may change within the window, allow retry after cooldown
      this.reactiveEvaluatingWindow = null;
      this.lastRoutingNoMatchWindow = windowId;
      this.lastRoutingNoMatchTime = Date.now();
      return this.finishCycle(cycle, startMs, 'agent_hold', {
        windowId,
        regime: regime.regime,
        reason: `No strategy matches regime '${regime.regime}'`,
      });
    }

    this.logger.log(`[${windowId}] Routed to: ${selectedStrategy.strategyKey}`);

    // 5. Apply selected strategy's filters
    //    Skip maxTimeToCloseSec for reactive — pre-compute handles entry timing.
    //    Reactive is a fallback that can run at any point in the window.
    const filters = selectedStrategy.filters;
    if (filters) {
      const reasons: string[] = [];
      const spreadBps = features.book?.spreadBps ?? 0;
      const depthScore = features.book?.depthScore ?? 0;
      const timeToCloseSec = Math.floor((features.market?.remainingMs ?? 0) / 1000);

      if (spreadBps > filters.maxSpreadBps) reasons.push(`spread ${spreadBps}bps > max ${filters.maxSpreadBps}bps`);
      if (depthScore < filters.minDepthScore) reasons.push(`depth ${depthScore.toFixed(2)} < min ${filters.minDepthScore}`);
      if (timeToCloseSec < filters.minTimeToCloseSec) reasons.push(`${timeToCloseSec}s to close < min ${filters.minTimeToCloseSec}s`);

      if (reasons.length > 0) {
        this.lastTradeWindowId = windowId;
        return this.finishCycle(cycle, startMs, 'strategy_filtered', { windowId, strategy: selectedStrategy.strategyKey, reasons });
      }
    }

    // Lock window — proceeding to edge/supervisor
    this.lastTradeWindowId = windowId;

    // 6. Sync risk profile for selected strategy
    if (selectedStrategy.riskProfile) {
      await this.postJson(`${RISK_SERVICE_URL}/api/v1/risk/config`, selectedStrategy.riskProfile).catch(() => null);
    }

    // Override execution mode from selected strategy
    if (selectedStrategy.executionPolicy?.mode) {
      executionMode = selectedStrategy.executionPolicy.mode;
    }

    const agentProfile = selectedStrategy.agentProfile;

    // 7. Call edge agent with strategy-specific profile
    const edgeResult: ServiceResponse = await this.postJson(`${AGENT_GATEWAY_URL}/api/v1/agent/edge/evaluate`, {
      windowId,
      features,
      agentProfile: agentProfile?.edgeAgentProfile,
    });

    if (!edgeResult) {
      return this.finishCycle(cycle, startMs, 'error', { windowId, reason: 'Edge evaluation failed' });
    }

    const edge: ServiceResponse = edgeResult.parsedOutput;
    this.logger.log(
      `[${windowId}] Edge: ${edge.direction} mag=${edge.magnitude} conf=${edge.confidence}`,
    );

    // 8. Call supervisor agent with strategy-specific profile
    const supervisorResult: ServiceResponse = await this.postJson(
      `${AGENT_GATEWAY_URL}/api/v1/agent/supervisor/evaluate`,
      {
        windowId,
        features,
        regime,
        edge,
        riskState: riskState.state,
        riskConfig: riskState.config,
        agentProfile: agentProfile?.supervisorAgentProfile,
      },
    );

    if (!supervisorResult) {
      return this.finishCycle(cycle, startMs, 'error', { windowId, reason: 'Supervisor evaluation failed' });
    }

    const decision: ServiceResponse = supervisorResult.parsedOutput;
    this.logger.log(
      `[${windowId}] Supervisor: ${decision.action} size=$${decision.sizeUsd} conf=${decision.confidence}`,
    );

    // 9. Post-filter: enforce minConfidence from selected strategy
    const minConfidence = selectedStrategy.decisionPolicy?.minConfidence;
    if (minConfidence && decision.action !== 'hold' && decision.confidence < minConfidence) {
      this.logger.log(`[${windowId}] Confidence ${decision.confidence} below strategy minimum ${minConfidence}, forcing hold`);
      decision.action = 'hold';
      decision.sizeUsd = 0;
    }

    this.eventBus.emit('agent.decision.made', {
      windowId,
      action: String(decision.action),
      sizeUsd: Number(decision.sizeUsd ?? 0),
      confidence: Number(decision.confidence),
    });

    this.lastTradeWindowId = windowId;

    if (decision.action === 'hold') {
      return this.finishCycle(cycle, startMs, 'agent_hold', {
        windowId,
        strategy: selectedStrategy.strategyKey,
        regime: regime.regime,
        edge: edge.direction,
        reasoning: decision.reasoning,
      });
    }

    return this.executeAfterApproval(cycle, startMs, windowId, decision, supervisorResult, features, executionMode);
  }

  // ─── Shared: Risk Evaluation + Execution ─────────────────────────────────────

  private async executeAfterApproval(
    cycle: number,
    startMs: number,
    windowId: string,
    decision: ServiceResponse,
    supervisorResult: ServiceResponse,
    features: ServiceResponse,
    executionMode: string,
  ): Promise<PipelineCycleResult> {
    // Risk evaluation
    const riskState: ServiceResponse = await this.fetchJson(`${RISK_SERVICE_URL}/api/v1/risk/state`);
    const riskEval: ServiceResponse = await this.postJson(`${RISK_SERVICE_URL}/api/v1/risk/evaluate`, {
      windowId,
      agentDecisionId: supervisorResult.id,
      proposal: decision,
      features,
      balanceUsd: INITIAL_BALANCE_USD,
      openExposureUsd: riskState?.state?.openPositionUsd ?? 0,
    });

    if (!riskEval || !riskEval.approved) {
      return this.finishCycle(cycle, startMs, 'risk_rejected', {
        windowId,
        action: decision.action,
        rejectionReasons: riskEval?.rejectionReasons ?? ['Risk service unavailable'],
      });
    }

    this.logger.log(`[${windowId}] Risk approved: $${riskEval.approvedSizeUsd}`);

    // Execute trade
    const side = decision.action === 'buy_up' ? 'UP' : 'DOWN';
    const executionEndpoint =
      executionMode === 'live' ? 'live-order' : 'paper-order';

    // Fetch market data for tokenIds (needed for live trading)
    let tokenId: string | undefined;
    let conditionId: string | undefined;
    if (executionMode === 'live') {
      const marketData: ServiceResponse = await this.fetchJson(`${MARKET_SERVICE_URL}/api/v1/market/active`);
      if (marketData) {
        tokenId = side === 'UP' ? marketData.upTokenId : marketData.downTokenId;
        conditionId = marketData.conditionId;
      }
    }

    const order: ServiceResponse = await this.postJson(
      `${EXECUTION_SERVICE_URL}/api/v1/execution/${executionEndpoint}`,
      {
        marketId: windowId,
        side,
        mode: executionMode,
        sizeUsd: riskEval.approvedSizeUsd,
        maxEntryPrice: side === 'UP'
          ? (features.book?.upAsk > 0 ? features.book.upAsk : 0.55)
          : (features.book?.downAsk > 0 ? features.book.downAsk : 0.55),
        mustExecuteBeforeSec: Math.max(Math.floor(((features.market?.remainingMs as number) ?? 60000) / 1000) - 15, 5),
        source: 'pipeline-orchestrator',
        windowId,
        riskDecisionId: riskEval.id,
        startPrice: features.market?.startPrice ?? features.price?.currentPrice ?? 0,
        tokenId,
        conditionId,
      },
    );

    if (!order) {
      return this.finishCycle(cycle, startMs, 'error', { windowId, reason: 'Execution failed' });
    }

    this.lastTradeWindowId = windowId;
    this.logger.log(
      `[${windowId}] Order executed: ${order.id} ${side} $${riskEval.approvedSizeUsd} (${executionMode})`,
    );

    return this.finishCycle(cycle, startMs, 'executed', {
      windowId,
      orderId: order.id,
      side,
      sizeUsd: riskEval.approvedSizeUsd,
      mode: executionMode,
      confidence: decision.confidence,
    });
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────────

  /**
   * Routes to the best matching strategy based on regime classification.
   * Returns null if no strategy matches (e.g. volatile regime).
   */
  private routeToStrategy(allStrategies: ServiceResponse[], regime: string): ServiceResponse | null {
    if (!Array.isArray(allStrategies) || allStrategies.length === 0) {
      this.logger.warn(`Strategy routing: no strategies available (got ${typeof allStrategies})`);
      return null;
    }

    this.logger.debug(`Strategy routing: ${allStrategies.length} strategies, regime=${regime}, available regimes: ${allStrategies.map((s: ServiceResponse) => `${s.strategyKey}:[${s.filters?.allowedRegimes?.join(',') ?? 'any'}]`).join(', ')}`);

    // Find strategy whose allowedRegimes includes this regime
    const matched = allStrategies.find(
      (s: ServiceResponse) => s.filters?.allowedRegimes?.includes(regime),
    );

    if (matched) return matched;

    // Fallback: if no strategy has allowedRegimes defined, use the first one (backward compat)
    const fallback = allStrategies.find(
      (s: ServiceResponse) => !s.filters?.allowedRegimes,
    );

    if (!fallback) {
      this.logger.warn(`Strategy routing: no strategy matches regime '${regime}'`);
    }

    return fallback ?? null;
  }

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
    } else if (stage === 'risk_rejected') {
      this.logger.warn(`Cycle #${cycle}: RISK REJECTED`, JSON.stringify(details));
    } else if (stage === 'precomputed') {
      this.logger.log(`Cycle #${cycle}: PRE-COMPUTED in ${result.durationMs}ms`);
    } else if (stage === 'gatekeeper_validated') {
      this.logger.log(`Cycle #${cycle}: GATEKEEPER VALIDATED in ${result.durationMs}ms`);
    } else if (stage === 'gatekeeper_invalidated') {
      this.logger.warn(`Cycle #${cycle}: GATEKEEPER INVALIDATED`, JSON.stringify(details));
    } else if (stage === 'validator_rejected') {
      this.logger.warn(`Cycle #${cycle}: VALIDATOR REJECTED`, JSON.stringify(details));
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
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) return null;
      const json = (await res.json()) as { ok: boolean; data: unknown };
      return json.ok ? (json.data ?? null) : null;
    } catch {
      return null;
    }
  }
}
