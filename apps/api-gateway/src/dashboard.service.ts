import { HttpService } from '@nestjs/axios';
import { Inject, Injectable } from '@nestjs/common';
import { firstValueFrom } from 'rxjs';

// ─── Service Host Resolution ──────────────────────────────────────────────────

const DEFAULT_HOST = process.env.SERVICE_HOST ?? process.env.LOCAL_IP ?? 'localhost';

const HOSTS = {
  'market-discovery': process.env.MARKET_DISCOVERY_HOST ?? DEFAULT_HOST,
  'price-feed': process.env.PRICE_FEED_HOST ?? DEFAULT_HOST,
  orderbook: process.env.ORDERBOOK_HOST ?? DEFAULT_HOST,
  'feature-engine': process.env.FEATURE_ENGINE_HOST ?? DEFAULT_HOST,
  risk: process.env.RISK_HOST ?? DEFAULT_HOST,
  execution: process.env.EXECUTION_HOST ?? DEFAULT_HOST,
  config: process.env.CONFIG_HOST ?? DEFAULT_HOST,
  'agent-gateway': process.env.AGENT_GATEWAY_HOST ?? DEFAULT_HOST,
  replay: process.env.REPLAY_HOST ?? DEFAULT_HOST,
  'whale-tracker': process.env.WHALE_TRACKER_HOST ?? DEFAULT_HOST,
  'post-trade-analyzer': process.env.POST_TRADE_ANALYZER_HOST ?? DEFAULT_HOST,
  'strategy-optimizer': process.env.STRATEGY_OPTIMIZER_HOST ?? DEFAULT_HOST,
  'derivatives-feed': process.env.DERIVATIVES_FEED_HOST ?? DEFAULT_HOST,
  'pipeline-orchestrator': process.env.PIPELINE_HOST ?? DEFAULT_HOST,
} as const;

const PORTS = {
  'market-discovery': 3001,
  'price-feed': 3002,
  orderbook: 3003,
  'feature-engine': 3004,
  risk: 3005,
  execution: 3006,
  config: 3007,
  'agent-gateway': 3008,
  replay: 3009,
  'whale-tracker': 3010,
  'post-trade-analyzer': 3011,
  'strategy-optimizer': 3012,
  'derivatives-feed': 3013,
  'pipeline-orchestrator': 3014,
} as const;

type ServiceName = keyof typeof PORTS;

// biome-ignore lint/suspicious/noExplicitAny: downstream service responses are untyped
type Rec = Record<string, any>;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function val(obj: Rec | null | undefined, ...keys: string[]): unknown {
  let cur: unknown = obj;
  for (const k of keys) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Rec)[k];
  }
  return cur;
}

function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' ? v : fallback;
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function extractOutput(trace: Rec | null): Rec | null {
  if (!trace) return null;
  const raw = trace.parsedOutput ?? trace.output ?? null;
  if (!raw) return null;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) as Rec; } catch { return null; }
  }
  return raw as Rec;
}

function traceToStep(label: string, trace: Rec | null, valueKey: string) {
  const output = extractOutput(trace);
  return {
    label,
    status: trace ? 'success' : 'pending',
    value: output ? str(output[valueKey], null as unknown as string) : null,
    confidence: output ? num(output.confidence, 0) : null,
    timestamp: trace ? str(trace.createdAt, null as unknown as string) : null,
  };
}

// ─── Service ──────────────────────────────────────────────────────────────────

@Injectable()
export class DashboardService {
  constructor(@Inject(HttpService) private readonly httpService: HttpService) {}

  // ─── System State ─────────────────────────────────────────────────────────

  async getSystemState() {
    const [config, riskState, market, strategy] = await Promise.all([
      this.fetch('config', '/api/v1/config'),
      this.fetch('risk', '/api/v1/risk/state'),
      this.fetch('market-discovery', '/api/v1/market/active'),
      this.fetch('config', '/api/v1/config/strategy'),
    ]);

    return {
      mode: str(val(config, 'trading', 'mode'), 'disabled'),
      activeMarket: {
        id: str(val(market, 'marketId') as string, ''),
        label: str(val(market, 'question') as string, 'Unknown'),
        asset: 'BTC',
        marketType: 'binary',
        windowSec: 300,
        resolverType: 'binance_spot',
        resolverSymbol: 'BTCUSDT',
        isActive: !!market,
      },
      currentStrategy: {
        key: str(val(strategy, 'strategyKey') as string, 'unknown'),
        version: num(val(strategy, 'version') as number, 0),
      },
      wsConnected: !!market,
      killSwitch: !!(riskState as Rec | null)?.killSwitchActive,
    };
  }

  // ─── Market Snapshot ──────────────────────────────────────────────────────

  async getMarketSnapshot() {
    const [priceCurrent, window, bookMetrics, market, features] = await Promise.all([
      this.fetch('price-feed', '/api/v1/price/current'),
      this.fetch('market-discovery', '/api/v1/market/window/current'),
      this.fetch('orderbook', '/api/v1/book/metrics'),
      this.fetch('market-discovery', '/api/v1/market/active'),
      this.fetch('feature-engine', '/api/v1/features/current'),
    ]);

    const resolver = (priceCurrent as Rec | null)?.resolver as Rec | undefined;
    const external = (priceCurrent as Rec | null)?.external as Rec | undefined;
    const win = (priceCurrent as Rec | null)?.window as Rec | undefined;
    const micro = (priceCurrent as Rec | null)?.micro as Rec | undefined;
    const up = (bookMetrics as Rec | null)?.up as Rec | undefined;
    const down = (bookMetrics as Rec | null)?.down as Rec | undefined;
    const mkt = market as Rec | null;
    const feat = features as Rec | null;
    const priceFeat = (feat?.price as Rec | undefined) ?? null;
    const sigFeat = (feat?.signals as Rec | undefined) ?? null;

    return {
      startPrice: num(win?.startPrice),
      currentPrice: num(resolver?.price),
      deltaAbs: num(win?.deltaAbs),
      deltaPct: num(win?.deltaPct),
      resolverPrice: num(resolver?.price),
      spotPrice: num(external?.price),
      spread: num((bookMetrics as Rec | null)?.spreadBps),
      depthScore: num((bookMetrics as Rec | null)?.liquidityScore),
      imbalance: num((bookMetrics as Rec | null)?.imbalance),
      momentum: num(micro?.momentumScore),
      volatility: num(micro?.volatility),
      timeToCloseMs: num((window as Rec | null)?.secondsToClose) * 1000,
      upBid: num(up?.bestBid),
      upAsk: num(up?.bestAsk),
      downBid: num(down?.bestBid),
      downAsk: num(down?.bestAsk),
      // Liquidity
      upBidDepth: num(up?.bidDepth),
      upAskDepth: num(up?.askDepth),
      downBidDepth: num(down?.bidDepth),
      downAskDepth: num(down?.askDepth),
      totalDepthUsd: num(up?.bidDepth) + num(up?.askDepth) + num(down?.bidDepth) + num(down?.askDepth),
      liquidityUsd: num(mkt?.liquidityUsd),
      volume24hUsd: num(mkt?.volume24hUsd),
      volumeTotalUsd: num(mkt?.volumeTotalUsd),
      microprice: num((bookMetrics as Rec | null)?.microprice),
      spreadBps: num((bookMetrics as Rec | null)?.spreadBps),
      // Poly lag tracker
      lagMs: num(priceFeat?.lagMs),
      predictiveBasisBps: num(priceFeat?.predictiveBasisBps),
      lagReliability: num(priceFeat?.lagReliability),
      lagSignal: str(sigFeat?.lagSignal as string, 'synced'),
      // Sweep detection
      sweep: (feat?.sweep as Rec | undefined) ?? null,
    };
  }

  // ─── Pipeline ─────────────────────────────────────────────────────────────

  async getPipeline() {
    const [regimeTraces, edgeTraces, supervisorTraces, gatekeeperTraces, evalTraces, riskState, latestPositions, currentWindow, pipelineStatus] =
      await Promise.all([
        this.fetch('agent-gateway', '/api/v1/agent/traces?agentType=regime&limit=1'),
        this.fetch('agent-gateway', '/api/v1/agent/traces?agentType=edge&limit=1'),
        this.fetch('agent-gateway', '/api/v1/agent/traces?agentType=supervisor&limit=1'),
        this.fetch('agent-gateway', '/api/v1/agent/traces?agentType=gatekeeper&limit=1'),
        this.fetch('agent-gateway', '/api/v1/agent/traces?agentType=eval&limit=1'),
        this.fetch('risk', '/api/v1/risk/state'),
        this.fetch('execution', '/api/v1/execution/positions'),
        this.fetch('market-discovery', '/api/v1/market/active'),
        this.fetch('pipeline-orchestrator', '/api/v1/pipeline/status'),
      ]);

    // Get current window ID from market discovery
    const currentWindowId = str((currentWindow as Rec | null)?.marketId as string);

    const rawRegime = Array.isArray(regimeTraces) ? ((regimeTraces[0] as Rec) ?? null) : null;
    const rawEdge = Array.isArray(edgeTraces) ? ((edgeTraces[0] as Rec) ?? null) : null;
    const rawSupervisor = Array.isArray(supervisorTraces)
      ? ((supervisorTraces[0] as Rec) ?? null)
      : null;
    const rawGatekeeper = Array.isArray(gatekeeperTraces) ? ((gatekeeperTraces[0] as Rec) ?? null) : null;
    const rawEval = Array.isArray(evalTraces) ? ((evalTraces[0] as Rec) ?? null) : null;

    // Accept traces from current window OR pre-computed next window
    const preComputedWindowSlug = str(val(pipelineStatus as Rec | null, 'preComputedDecision', 'targetWindowSlug') as string);
    const matchesWindow = (traceWindowId: string | undefined) => {
      if (!traceWindowId) return false;
      if (!currentWindowId && !preComputedWindowSlug) return true;
      return traceWindowId === currentWindowId || traceWindowId === preComputedWindowSlug;
    };
    const regimeWindowMatch = matchesWindow(str(rawRegime?.windowId as string));
    const edgeWindowMatch = matchesWindow(str(rawEdge?.windowId as string));
    const supervisorWindowMatch = matchesWindow(str(rawSupervisor?.windowId as string));
    const gatekeeperWindowMatch = matchesWindow(str(rawGatekeeper?.windowId as string));

    const regime = regimeWindowMatch ? rawRegime : null;
    const edge = edgeWindowMatch ? rawEdge : null;
    const supervisor = supervisorWindowMatch ? rawSupervisor : null;
    const gatekeeper = gatekeeperWindowMatch ? rawGatekeeper : null;

    // Pipeline orchestrator status for context
    const pipeRec = pipelineStatus as Rec | null;
    const pipeStage = str(val(pipeRec, 'lastResult', 'stage') as string);
    const pipeDetails = (val(pipeRec, 'lastResult', 'details') as Rec) ?? {};
    const pipeRunning = !!pipeRec?.running;
    const pipeCycles = num(pipeRec?.cycleCount as number);

    // Risk step: derive from pipeline result when available, fall back to general state
    const riskRec = riskState as Rec | null;
    const hasRiskData = !!riskRec;
    const killSwitch = !!riskRec?.killSwitchActive;
    const tradingEnabled = riskRec?.tradingEnabled !== false;
    const remainingBudget = num(riskRec?.remainingDailyBudgetUsd as number);

    // Use pipeline stage to determine if risk actually passed for this cycle
    const pipelineRejectedByRisk = pipeStage === 'risk_rejected';
    const pipelinePassedRisk = pipeStage === 'executed' || pipeStage === 'agent_hold';
    const riskPassed = pipelineRejectedByRisk
      ? false
      : pipelinePassedRisk
        ? true
        : hasRiskData && !killSwitch && tradingEnabled && remainingBudget > 0;

    // Execution step: derive from real execution service positions
    const positions = Array.isArray(latestPositions) ? latestPositions : [];
    const latestPosition = (positions[0] as Rec | undefined) ?? null;
    const hasExecution = !!latestPosition;

    // For pending agent steps, show pipeline stage as context
    const preComputeAction = str(val(pipeRec, 'preComputedDecision', 'action') as string);
    const isPreComputed = pipeStage === 'precomputed' || !!preComputeAction;
    const preComputedHold = preComputeAction === 'hold';

    // Agent steps (regime/router/edge/supervisor): show pre-computed when available
    const pendingValue = pipeStage === 'not_tradeable' ? 'not tradeable'
      : pipeStage === 'error' ? str(pipeDetails.reason as string, 'error')
      : pipeStage === 'no_features' ? 'no data'
      : pipeRunning ? 'evaluating...'
      : pipeCycles > 0 ? 'Waiting...'
      : null;

    // Post-agent steps (gatekeeper/risk/execution/eval): show hold or waiting
    const postAgentPendingValue = preComputedHold ? 'skipped'
      : isPreComputed ? 'Waiting...'
      : pendingValue;

    const pendingStatus = pipeStage === 'error' ? 'failed' as const
      : pipeRunning ? 'running' as const
      : 'pending' as const;

    // Derive Router step from regime output — map regime to strategy name
    const regimeOutput = extractOutput(regime);
    const regimeValue = regimeOutput ? str(regimeOutput.regime as string) : null;
    const REGIME_TO_STRATEGY: Record<string, string> = {
      trending_up: 'Momentum',
      trending_down: 'Momentum',
      volatile: 'Momentum',
      mean_reverting: 'Mean Reversion',
      quiet: 'Mean Reversion',
    };
    const routedStrategy = regimeValue ? REGIME_TO_STRATEGY[regimeValue] ?? null : null;
    const routerStatus = !regime ? pendingStatus
      : routedStrategy ? 'success' as const
      : 'failed' as const;
    const routerValue = !regime ? pendingValue
      : routedStrategy ?? 'no match';

    // Derive edge profile name from the trace model or agent type
    const edgeOutput = extractOutput(edge);
    const edgeProfile = edge ? str(edge.agentProfile as string) || str(edge.model as string) : null;
    const edgeLabel = routedStrategy === 'Mean Reversion' ? 'Edge (MR)' : 'Edge';

    const gatekeeperOutput = extractOutput(gatekeeper);

    return [
      regime ? traceToStep('Regime', regime, 'regime') : { label: 'Regime', status: pendingStatus, value: pendingValue, confidence: null, timestamp: null },
      {
        label: 'Router',
        status: routerStatus,
        value: routerValue,
        confidence: null,
        timestamp: regime ? str(regime.createdAt as string) : null,
      },
      edge ? { ...traceToStep(edgeLabel, edge, 'direction'), detail: edgeProfile ? { profile: edgeProfile } : null } : { label: edgeLabel, status: pendingStatus, value: pendingValue, confidence: null, timestamp: null },
      supervisor ? traceToStep('Supervisor', supervisor, 'action') : { label: 'Supervisor', status: pendingStatus, value: pendingValue, confidence: null, timestamp: null },
      {
        label: 'Gatekeeper',
        status: gatekeeper ? (gatekeeperOutput?.validated ? 'success' as const : 'failed' as const) : pendingStatus,
        value: gatekeeper ? (gatekeeperOutput?.validated ? 'validated' : 'invalidated') : postAgentPendingValue,
        confidence: null,
        timestamp: gatekeeper ? str(gatekeeper.createdAt as string) : null,
        detail: gatekeeperOutput ? { reasoning: str(gatekeeperOutput.reasoning as string) } : null,
      },
      {
        label: 'Risk',
        status: hasRiskData ? (pipelineRejectedByRisk ? 'failed' : 'success') : 'pending',
        value: hasRiskData ? (riskPassed ? 'passed' : 'blocked') : postAgentPendingValue,
        confidence: null,
        timestamp: riskRec?.updatedAt ? str(riskRec.updatedAt as string) : null,
        detail: hasRiskData
          ? {
              killSwitch,
              tradingEnabled,
              remainingBudgetUsd: remainingBudget,
              dailyPnlUsd: num(val(riskRec, 'state', 'dailyPnlUsd') as number),
              ...(pipelineRejectedByRisk ? { rejectionReasons: pipeDetails.rejectionReasons } : {}),
            }
          : null,
      },
      {
        label: 'Execution',
        status: hasExecution ? 'success' : 'pending',
        value: hasExecution ? str(latestPosition.id as string) : postAgentPendingValue,
        confidence: null,
        timestamp: hasExecution
          ? str((latestPosition.openedAt ?? latestPosition.createdAt) as string)
          : null,
        detail: hasExecution
          ? {
              side: str(latestPosition.side as string),
              sizeUsd: num(latestPosition.sizeUsd as number),
              mode: str(latestPosition.mode as string),
            }
          : null,
      },
      (() => {
        const evalOutput = extractOutput(rawEval);
        return {
          label: 'Eval',
          status: rawEval ? 'success' as const : 'pending' as const,
          value: rawEval ? `patch → ${str(evalOutput?.targetAgent as string, '?')}` : postAgentPendingValue,
          confidence: evalOutput ? num(evalOutput.confidence as number) : null,
          timestamp: rawEval ? str(rawEval.createdAt as string) : null,
          detail: evalOutput ? {
            targetAgent: str(evalOutput.targetAgent as string),
            reasoning: str(evalOutput.reasoning as string),
          } : null,
        };
      })(),
    ];
  }

  // ─── Trades ───────────────────────────────────────────────────────────────

  async getOpenTrades() {
    const positions = await this.fetch('execution', '/api/v1/execution/positions');
    if (!Array.isArray(positions)) return [];

    return positions.map((position: Rec, index: number) => ({
      id: str(position.id, `pos_${index}`),
      market: 'BTC-5MIN-UP',
      side: position.side,
      strategy: 'btc_5m_momentum_v1',
      mode: position.mode,
      entryTime: position.openedAt,
      entryPrice: position.avgEntryPrice,
      sizeUsd: position.sizeUsd,
      currentMark: position.avgEntryPrice,
      unrealizedPnl: 0,
      status: 'filled',
      traceId: position.traceId ?? null,
    }));
  }

  async getClosedTrades() {
    const resolved = await this.fetch('execution', '/api/v1/execution/resolved?limit=50');
    if (!Array.isArray(resolved)) return [];

    return resolved.map((r: Rec) => {
      const pnl = num(r.pnlUsd);
      const sizeUsd = num(r.sizeUsd);
      return {
        id: r.id,
        market: 'BTC-5MIN-UP',
        side: str(r.side, 'buy_up'),
        strategy: 'btc_5m_momentum_v1',
        entryTime: r.createdAt,
        exitTime: r.resolvedAt,
        duration: num(r.durationMs),
        pnl,
        pnlPct: sizeUsd > 0 ? (pnl / sizeUsd) * 100 : 0,
        result: str(r.outcome, pnl > 0 ? 'win' : pnl < 0 ? 'loss' : 'breakeven'),
        exitReason: 'window_resolved',
        traceId: null,
      };
    });
  }

  // ─── Metrics ──────────────────────────────────────────────────────────────

  async getTodayMetrics() {
    const [resolved, riskState] = await Promise.all([
      this.fetch('execution', '/api/v1/execution/resolved?limit=100'),
      this.fetch('risk', '/api/v1/risk/state'),
    ]);

    const trades = Array.isArray(resolved) ? (resolved as Rec[]) : [];
    const realizedPnl = trades.reduce((sum, t) => sum + num(t.pnlUsd), 0);
    const tradeCount = trades.length;
    const winCount = trades.filter((t) => str(t.outcome) === 'win').length;
    const lossCount = trades.filter((t) => str(t.outcome) === 'loss').length;

    const sumWins = trades.filter((t) => num(t.pnlUsd) > 0).reduce((s, t) => s + num(t.pnlUsd), 0);
    const sumLosses = Math.abs(trades.filter((t) => num(t.pnlUsd) < 0).reduce((s, t) => s + num(t.pnlUsd), 0));

    // Compute current streaks (most recent trades first)
    let winStreak = 0;
    let lossStreak = 0;
    for (const t of trades) {
      const outcome = str(t.outcome);
      if (outcome === 'win') { if (lossStreak === 0) winStreak++; else break; }
      else if (outcome === 'loss') { if (winStreak === 0) lossStreak++; else break; }
      else break;
    }

    return {
      realizedPnl,
      unrealizedPnl: num(val(riskState, 'state', 'openPositionUsd') as number),
      tradeCount,
      winCount,
      lossCount,
      breakevenCount: tradeCount - winCount - lossCount,
      winRate: tradeCount > 0 ? winCount / tradeCount : 0,
      profitFactor: sumLosses > 0 ? sumWins / sumLosses : 0,
      avgPnl: tradeCount > 0 ? realizedPnl / tradeCount : 0,
      maxDrawdown: num(val(riskState, 'state', 'dailyPnlUsd') as number),
      winStreak,
      lossStreak,
    };
  }

  async getSimulationSummary() {
    const [resolved, riskState] = await Promise.all([
      this.fetch('execution', '/api/v1/execution/resolved?limit=100'),
      this.fetch('risk', '/api/v1/risk/state'),
    ]);

    const trades = Array.isArray(resolved) ? (resolved as Rec[]) : [];
    const paperTrades = trades.filter((t) => t.mode === 'paper');

    const realizedPnl = paperTrades.reduce((sum, t) => sum + num(t.pnlUsd), 0);
    const tradeCount = paperTrades.length;
    const winCount = paperTrades.filter((t) => str(t.outcome) === 'win').length;
    const lossCount = paperTrades.filter((t) => str(t.outcome) === 'loss').length;
    const winRate = tradeCount > 0 ? winCount / tradeCount : 0;

    const sumWins = paperTrades.filter((t) => num(t.pnlUsd) > 0).reduce((s, t) => s + num(t.pnlUsd), 0);
    const sumLosses = Math.abs(paperTrades.filter((t) => num(t.pnlUsd) < 0).reduce((s, t) => s + num(t.pnlUsd), 0));
    const profitFactor = sumLosses > 0 ? sumWins / sumLosses : 0;

    const avgDurationMs = tradeCount > 0
      ? paperTrades.reduce((sum, t) => sum + num(t.durationMs), 0) / tradeCount
      : 0;

    let currentWinStreak = 0;
    for (const t of paperTrades) {
      if (str(t.outcome) === 'win') currentWinStreak++;
      else break;
    }

    let currentLossStreak = 0;
    for (const t of paperTrades) {
      if (str(t.outcome) === 'loss') currentLossStreak++;
      else break;
    }

    return {
      realizedPnl,
      unrealizedPnl: num(val(riskState, 'state', 'openPositionUsd') as number),
      tradeCount,
      winCount,
      lossCount,
      breakevenCount: tradeCount - winCount - lossCount,
      winRate,
      profitFactor,
      avgPnl: tradeCount > 0 ? realizedPnl / tradeCount : 0,
      maxDrawdown: num(val(riskState, 'state', 'dailyPnlUsd') as number),
      paperTradesToday: tradeCount,
      avgHoldTime: avgDurationMs > 0 ? `${Math.round(avgDurationMs / 1000)}s` : 'N/A',
      falsePositiveRate: 0,
      noTradeRate: 0,
      currentWinStreak,
      currentLossStreak,
      greenDayStreak: 0,
    };
  }

  // ─── LLM Costs ──────────────────────────────────────────────────────────

  async getLlmCosts() {
    return this.fetch('agent-gateway', '/api/v1/agent/costs');
  }

  // ─── Price & Book History ─────────────────────────────────────────────────

  private rangeToMs(range: string): { durationMs: number; interval: string } {
    switch (range) {
      case '1m':  return { durationMs: 1 * 60 * 1000, interval: '1s' };
      case '5m':  return { durationMs: 5 * 60 * 1000, interval: '2s' };
      case '10m': return { durationMs: 10 * 60 * 1000, interval: '5s' };
      case '30m': return { durationMs: 30 * 60 * 1000, interval: '15s' };
      default:    return { durationMs: 5 * 60 * 1000, interval: '2s' };
    }
  }

  async getPriceHistory(range = '5m') {
    const { durationMs, interval } = this.rangeToMs(range);
    const now = new Date();
    const from = new Date(now.getTime() - durationMs).toISOString();
    const to = now.toISOString();
    const data = await this.fetch('price-feed', `/api/v1/price/history?from=${from}&to=${to}&source=all&interval=${interval}`);

    const ticks = Array.isArray(data) ? data : ((data as Rec | null)?.ticks as Rec[] ?? []);
    if (!Array.isArray(ticks) || ticks.length === 0) return [];

    return ticks.map((tick: Rec) => ({
      time: tick.timestamp ?? tick.time ?? tick.t,
      resolverPrice: num(tick.price),
      spotPrice: num(tick.price),
    }));
  }

  async getBookHistory(range = '5m') {
    const { durationMs } = this.rangeToMs(range);
    const now = new Date();
    const from = new Date(now.getTime() - durationMs).toISOString();
    const to = now.toISOString();
    const data = await this.fetch('orderbook', `/api/v1/book/history?from=${from}&to=${to}`);

    const snapshots = Array.isArray(data) ? data : ((data as Rec | null)?.snapshots as Rec[] ?? []);
    if (!Array.isArray(snapshots) || snapshots.length === 0) return [];

    return snapshots.map((snap: Rec) => ({
      time: snap.timestamp ?? snap.time ?? snap.t,
      spread: num(snap.spreadBps ?? snap.spread) / 10_000,
      depthScore: num(snap.depthScore ?? snap.liquidityScore),
      imbalance: num(snap.imbalance),
    }));
  }

  // ─── Service Health ─────────────────────────────────────────────────────

  async getServiceHealth() {
    const entries: { name: ServiceName; healthPath: string }[] = [
      { name: 'market-discovery', healthPath: '/api/v1/market/active' },
      { name: 'price-feed', healthPath: '/api/v1/price/current' },
      { name: 'orderbook', healthPath: '/api/v1/book/current' },
      { name: 'feature-engine', healthPath: '/api/v1/features/current' },
      { name: 'risk', healthPath: '/api/v1/risk/state' },
      { name: 'execution', healthPath: '/api/v1/execution/positions' },
      { name: 'config', healthPath: '/api/v1/config' },
      { name: 'agent-gateway', healthPath: '/api/v1/agent/traces?limit=1' },
      { name: 'replay', healthPath: '/api/v1/replay/summary' },
    ];

    return Promise.all(entries.map((svc) => this.pingService(svc.name, svc.healthPath)));
  }

  // ─── Feed Status ────────────────────────────────────────────────────────

  async getFeedStatus() {
    const startPrice = Date.now();
    const priceCurrent = await this.fetch('price-feed', '/api/v1/price/current');
    const priceLatency = Date.now() - startPrice;

    const startBook = Date.now();
    const bookCurrent = await this.fetch('orderbook', '/api/v1/book/current');
    const bookLatency = Date.now() - startBook;

    return [
      {
        name: 'binance-ws',
        type: 'resolver',
        connected: !!priceCurrent,
        latencyMs: priceLatency,
        lastMessage: (priceCurrent as Rec | null)?.timestamp ?? null,
        messageRate: null,
      },
      {
        name: 'polymarket-ws',
        type: 'orderbook',
        connected: !!bookCurrent,
        latencyMs: bookLatency,
        lastMessage: (bookCurrent as Rec | null)?.timestamp ?? null,
        messageRate: null,
      },
    ];
  }

  // ─── Events ─────────────────────────────────────────────────────────────

  async getEvents() {
    const [traces, fills] = await Promise.all([
      this.fetch('agent-gateway', '/api/v1/agent/traces?limit=10'),
      this.fetch('execution', '/api/v1/execution/fills?limit=5'),
    ]);

    const events: {
      id: string;
      time: string;
      source: string;
      type: string;
      severity: string;
      message: string;
    }[] = [];

    if (Array.isArray(traces)) {
      for (const trace of traces) {
        const t = trace as Rec;
        events.push({
          id: str(t.id, `trace_${events.length}`),
          time: str(t.createdAt, new Date().toISOString()),
          source: 'agent-gateway',
          type: `agent.${str(t.agentType, 'unknown')}`,
          severity: 'info',
          message: `${str(t.agentType, 'Agent')} trace completed`,
        });
      }
    }

    if (Array.isArray(fills)) {
      for (const fill of fills) {
        const f = fill as Rec;
        events.push({
          id: str(f.id, `fill_${events.length}`),
          time: str(f.filledAt, new Date().toISOString()),
          source: 'execution',
          type: 'trade.fill',
          severity: 'info',
          message: `Fill: ${str(f.side, 'unknown')} ${num(f.sizeUsd)} USD`,
        });
      }
    }

    events.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
    return events;
  }

  // ─── Stream Update ──────────────────────────────────────────────────────

  async getStreamUpdate() {
    const [snapshot, pipeline, health] = await Promise.all([
      this.getMarketSnapshot(),
      this.getPipeline(),
      this.getServiceHealth(),
    ]);
    return { snapshot, pipeline, health, timestamp: new Date().toISOString() };
  }

  // ─── Internal Helpers ───────────────────────────────────────────────────

  private computeMetrics(fills: unknown, riskState: Rec | null) {
    const safeFills = Array.isArray(fills) ? (fills as Rec[]) : [];

    const realizedPnl = safeFills.reduce((sum, f) => sum + num(f.pnlUsd), 0);
    const tradeCount = safeFills.length;
    const winCount = safeFills.filter((f) => num(f.pnlUsd) > 0).length;
    const lossCount = safeFills.filter((f) => num(f.pnlUsd) < 0).length;
    const breakevenCount = safeFills.filter((f) => num(f.pnlUsd) === 0).length;

    const sumWins = safeFills
      .filter((f) => num(f.pnlUsd) > 0)
      .reduce((s, f) => s + num(f.pnlUsd), 0);
    const sumLosses = Math.abs(
      safeFills.filter((f) => num(f.pnlUsd) < 0).reduce((s, f) => s + num(f.pnlUsd), 0),
    );

    return {
      realizedPnl,
      unrealizedPnl: num(val(riskState, 'state', 'openPositionUsd') as number),
      tradeCount,
      winCount,
      lossCount,
      breakevenCount,
      winRate: tradeCount > 0 ? winCount / tradeCount : 0,
      profitFactor: sumLosses > 0 ? sumWins / sumLosses : 0,
      avgPnl: tradeCount > 0 ? realizedPnl / tradeCount : 0,
      maxDrawdown: num(val(riskState, 'state', 'dailyPnlUsd') as number),
    };
  }

  private async pingService(name: ServiceName, healthPath: string) {
    const startMs = Date.now();
    try {
      const url = `http://${HOSTS[name]}:${PORTS[name]}${healthPath}`;
      const response = await firstValueFrom(
        this.httpService.get(url, { timeout: 5_000, validateStatus: () => true }),
      );
      const latencyMs = Date.now() - startMs;
      const isOk = response.status >= 200 && response.status < 400;

      return {
        name,
        status: isOk
          ? latencyMs > 2000
            ? ('degraded' as const)
            : ('healthy' as const)
          : ('degraded' as const),
        lastHeartbeat: new Date().toISOString(),
        latencyMs,
        errorCount: isOk ? 0 : 1,
      };
    } catch {
      return {
        name,
        status: 'unhealthy' as const,
        lastHeartbeat: new Date().toISOString(),
        latencyMs: Date.now() - startMs,
        errorCount: 1,
      };
    }
  }

  private async fetch<T = Rec>(service: ServiceName, path: string): Promise<T | null> {
    try {
      const url = `http://${HOSTS[service]}:${PORTS[service]}${path}`;
      const response = await firstValueFrom(
        this.httpService.get<{ ok: boolean; data: T }>(url, { timeout: 5_000 }),
      );
      if (response.data?.ok) return response.data.data;
      return null;
    } catch {
      return null;
    }
  }
}
