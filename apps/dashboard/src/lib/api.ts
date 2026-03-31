function getApiBase(): string {
  if (process.env.NEXT_PUBLIC_API_URL) return process.env.NEXT_PUBLIC_API_URL;
  if (typeof window !== 'undefined') return `http://${window.location.hostname}:3000`;
  return 'http://localhost:3000';
}

class ApiError extends Error {
  constructor(public status: number, path: string) {
    super(`${path} returned ${status}`);
    this.name = 'ApiError';
  }
}

async function fetchApi<T>(path: string): Promise<T | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);

  try {
    const res = await fetch(`${getApiBase()}${path}`, { signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) {
      throw new ApiError(res.status, path);
    }

    const json = await res.json();
    return (json.data as T) ?? null;
  } catch (err) {
    clearTimeout(timeout);
    if (err instanceof ApiError) throw err;
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error(`Timeout: ${path}`);
    }
    throw new Error(`Network error: ${path}`);
  }
}

// ─── API Functions (no mock fallback — null when unavailable) ───────────────

export async function getSystemState() {
  return await fetchApi<{
    mode: string;
    activeMarket: { id: string; label: string; asset: string; marketType: string; windowSec: number; resolverType: string; resolverSymbol: string; isActive: boolean } | null;
    currentStrategy: { key: string; version: number } | null;
    wsConnected: boolean;
    killSwitch: boolean;
  }>('/api/v1/dashboard/state');
}

export async function getMarketSnapshot() {
  return await fetchApi<{
    startPrice: number;
    currentPrice: number;
    deltaAbs: number;
    deltaPct: number;
    resolverPrice: number;
    spotPrice: number;
    spread: number;
    depthScore: number;
    imbalance: number;
    momentum: number;
    volatility: number;
    timeToCloseMs: number;
    upBid: number;
    upAsk: number;
    downBid: number;
    downAsk: number;
  }>('/api/v1/dashboard/snapshot');
}

export async function getPipeline() {
  return await fetchApi<{ label: string; status: string; value: string | null; confidence: number | null; timestamp: string | null }[]>('/api/v1/dashboard/pipeline');
}

export async function getOpenTrades() {
  return await fetchApi<{ id: string; market: string; side: string; strategy: string; mode: string; entryTime: string; entryPrice: number; sizeUsd: number; currentMark: number; unrealizedPnl: number; status: string; traceId: string | null }[]>('/api/v1/dashboard/trades/open');
}

export async function getClosedTrades() {
  return await fetchApi<{ id: string; market: string; side: string; strategy: string; entryTime: string; exitTime: string; duration: number; pnl: number; pnlPct: number; result: string; exitReason: string; traceId: string | null }[]>('/api/v1/dashboard/trades/closed');
}

export async function getServiceHealth() {
  return await fetchApi<{ name: string; status: 'healthy' | 'degraded' | 'unhealthy'; lastHeartbeat: string; latencyMs: number; errorCount: number }[]>('/api/v1/dashboard/health');
}

export async function getTodayMetrics() {
  return await fetchApi<{
    realizedPnl: number;
    unrealizedPnl: number;
    tradeCount: number;
    winCount: number;
    lossCount: number;
    breakevenCount: number;
    winRate: number;
    profitFactor: number;
    avgPnl: number;
    maxDrawdown: number;
  }>('/api/v1/dashboard/metrics');
}

export async function getSimulationSummary() {
  return await fetchApi<{
    realizedPnl: number;
    tradeCount: number;
    winCount: number;
    lossCount: number;
    winRate: number;
    profitFactor: number;
    avgPnl: number;
    paperTradesToday: number;
    avgHoldTime: string;
    falsePositiveRate: number;
    noTradeRate: number;
    currentWinStreak: number;
    currentLossStreak: number;
    greenDayStreak: number;
  }>('/api/v1/dashboard/simulation');
}

export type TimeRange = '1m' | '5m' | '10m' | '30m';

export async function getPriceHistory(range: TimeRange = '5m') {
  return await fetchApi<{ time: string; resolverPrice: number; spotPrice: number }[]>(`/api/v1/dashboard/prices?range=${range}`);
}

export async function getBookHistory(range: TimeRange = '5m') {
  return await fetchApi<{ time: string; spread: number; depthScore: number; imbalance: number }[]>(`/api/v1/dashboard/book?range=${range}`);
}

export async function getEvents() {
  return await fetchApi<{ id: string; time: string; source: string; type: string; severity: string; message: string }[]>('/api/v1/dashboard/events');
}

export async function getFeedStatus() {
  return await fetchApi<{ name: string; type: string; connected: boolean; latencyMs: number; lastMessage: string | null; messageRate: number | null }[]>('/api/v1/dashboard/feeds');
}

// ─── Whale Tracker API Functions ─────────────────────────────────────────

export async function getWhaleFeatures() {
  return await fetchApi<{
    largeTransactionCount: number;
    netExchangeFlowBtc: number;
    exchangeFlowPressure: number;
    whaleVolumeBtc: number;
    abnormalActivityScore: number;
    lastWhaleEventTime: number | null;
  }>('/api/v1/whales/current');
}

export async function getWhaleTransactions() {
  return await fetchApi<{
    txid: string;
    amountBtc: number;
    amountUsd: number;
    direction: string;
    fromAddress: string;
    toAddress: string;
    isExchangeInflow: boolean;
    isExchangeOutflow: boolean;
    eventTime: number;
  }[]>('/api/v1/whales/transactions?limit=20');
}

export async function getWhaleHistory() {
  return await fetchApi<{
    features: {
      largeTransactionCount: number;
      netExchangeFlowBtc: number;
      exchangeFlowPressure: number;
      whaleVolumeBtc: number;
      abnormalActivityScore: number;
    };
    eventTime: number;
  }[]>('/api/v1/whales/history?limit=30');
}

export async function getBlockchainActivity() {
  return await fetchApi<{
    window: { durationMs: number; startTime: number };
    mempool: { txCount: number; totalFeeBtc: number; vsize: number };
    fees: { fastest: number; halfHour: number; hour: number; economy: number; minimum: number };
    latestBlock: { height: number; txCount: number; size: number; timestamp: number } | null;
    notableTransactions: {
      total: number;
      totalBtc: number;
      totalUsd: number;
      exchangeInflows: { count: number; btc: number };
      exchangeOutflows: { count: number; btc: number };
      largest: { txid: string; amountBtc: number; amountUsd: number; direction: string } | null;
    };
    trend: { txCountChange: number; volumeChange: number; feeChange: number };
    lastUpdated: number;
  }>('/api/v1/whales/blockchain');
}

// ─── Derivatives Feed API Functions ──────────────────────────────────────

export async function getDerivativesFeatures() {
  return await fetchApi<{
    fundingRate: number;
    fundingRateAnnualized: number;
    fundingPressure: number;
    openInterestUsd: number;
    openInterestChangePct: number;
    oiTrend: number;
    longLiquidationUsd: number;
    shortLiquidationUsd: number;
    liquidationImbalance: number;
    liquidationIntensity: number;
    derivativesSentiment: number;
  }>('/api/v1/derivatives/current');
}

export async function getDerivativesLiquidations() {
  return await fetchApi<{
    symbol: string;
    side: string;
    price: number;
    quantity: number;
    quantityUsd: number;
    eventTime: number;
  }[]>('/api/v1/derivatives/liquidations?limit=30');
}

export async function getDerivativesHistory() {
  return await fetchApi<{
    features: {
      fundingPressure: number;
      oiTrend: number;
      liquidationIntensity: number;
      derivativesSentiment: number;
      openInterestUsd: number;
      longLiquidationUsd: number;
      shortLiquidationUsd: number;
    };
    eventTime: number;
  }[]>('/api/v1/derivatives/history?limit=30');
}

// ─── Post-Trade Analyzer API Functions ───────────────────────────────────

export async function getTradeAnalyses(params?: { verdict?: string; limit?: number }) {
  const query = new URLSearchParams();
  if (params?.verdict) query.set('verdict', params.verdict);
  if (params?.limit) query.set('limit', String(params.limit));
  const qs = query.toString();
  return await fetchApi<{
    id: string;
    windowId: string;
    orderId: string;
    verdict: string;
    pnlUsd: number;
    pnlBps: number;
    entryPrice: number;
    exitPrice: number;
    side: string;
    sizeUsd: number;
    regimeAtEntry: string;
    edgeDirectionAtEntry: string;
    edgeMagnitudeAtEntry: number;
    supervisorConfidence: number;
    edgeAccurate: boolean;
    confidenceCalibration: string;
    misleadingSignals: string[];
    correctSignals: string[];
    improvementSuggestions: string[];
    llmReasoning: string;
    model: string;
    provider: string;
    latencyMs: number;
    createdAt: string;
  }[]>(`/api/v1/analyzer/analyses${qs ? `?${qs}` : ''}`);
}

// ─── Strategy Optimizer API Functions ────────────────────────────────────

export async function getStrategyReports(limit?: number) {
  const qs = limit ? `?limit=${limit}` : '';
  return await fetchApi<{
    id: string;
    periodStart: string;
    periodEnd: string;
    totalTrades: number;
    totalPnlUsd: number;
    winRate: number;
    avgEdgeMagnitude: number;
    maxDrawdownUsd: number;
    performanceByRegime: Record<string, { trades: number; pnlUsd: number; winRate: number }>;
    performanceByHour: Record<string, { trades: number; pnlUsd: number }>;
    agentAccuracy: { edgePredictionAccuracy: number; confidenceCalibration: number; regimeAccuracy: number };
    riskMetrics: { rejectionRate: number; topRejectionReasons: string[] };
    patterns: string[];
    suggestions: { category: string; suggestion: string; rationale: string; confidence: number; priority: string; autoApplicable: boolean }[];
    executiveSummary: string;
    createdAt: string;
  }[]>(`/api/v1/optimizer/reports${qs}`);
}

export async function getOptimizerStatus() {
  return await fetchApi<{
    enabled: boolean;
    isRunning: boolean;
    lastRunAt: string | null;
    intervalMs: number;
  }>('/api/v1/optimizer/status');
}

// ─── Agent Gateway API Functions ────────────────────────────────────────

export interface AgentTrace {
  traceId: string;
  windowId: string;
  agentType: 'regime' | 'edge' | 'supervisor';
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  model: string;
  provider: string;
  latencyMs: number;
  tokenCount: number;
  createdAt: string;
}

export async function getAgentTraces(params?: { agentType?: string; limit?: number }) {
  const query = new URLSearchParams();
  if (params?.agentType) query.set('agentType', params.agentType);
  if (params?.limit) query.set('limit', String(params.limit));
  const qs = query.toString();
  return await fetchApi<AgentTrace[]>(`/api/v1/agent/traces${qs ? `?${qs}` : ''}`);
}

export async function getAgentContext() {
  return await fetchApi<Record<string, unknown>>('/api/v1/agent/context');
}

// ─── Replay API Functions ───────────────────────────────────────────────

export interface ReplayResult {
  replayId: string;
  windowId: string;
  startTime: string;
  endTime: string;
  regime: string;
  edgeDirection: string;
  edgeMagnitude: number;
  supervisorAction: string;
  supervisorConfidence: number;
  actualOutcome: string;
  pnlUsd: number;
  correct: boolean;
  createdAt: string;
}

export async function getReplaySummary() {
  return await fetchApi<{
    totalReplays: number;
    totalWindows: number;
    correctPredictions: number;
    accuracy: number;
    totalPnlUsd: number;
    avgConfidence: number;
    byRegime: Record<string, { count: number; correct: number; pnlUsd: number }>;
  }>('/api/v1/replay/summary');
}

export async function getReplayResult(replayId: string) {
  return await fetchApi<ReplayResult[]>(`/api/v1/replay/${replayId}`);
}

export async function startReplay(params: { from: string; to: string }) {
  return await postApi<{ replayId: string }>('/api/v1/replay/run', params);
}

// ─── Risk State API ─────────────────────────────────────────────────────────

export interface RiskStateResponse {
  config: {
    maxSizeUsd: number;
    dailyLossLimitUsd: number;
    maxSpreadBps: number;
    minDepthScore: number;
    maxTradesPerWindow: number;
  };
  state: {
    dailyPnlUsd: number;
    openPositionUsd: number;
    tradesInWindow: number;
    lastTradeTime: string | null;
  };
  remainingDailyBudgetUsd: number;
  killSwitchActive: boolean;
  tradingEnabled: boolean;
  updatedAt: string;
}

export async function getRiskState() {
  return await fetchApi<RiskStateResponse>('/api/v1/risk/state');
}

// ─── Mutations (POST) ───────────────────────────────────────────────────────

async function postApi<T>(path: string, body: Record<string, unknown>): Promise<T | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const res = await fetch(`${getApiBase()}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      throw new ApiError(res.status, path);
    }

    const json = await res.json();
    return (json.data as T) ?? null;
  } catch (err) {
    clearTimeout(timeout);
    if (err instanceof ApiError) throw err;
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error(`Timeout: ${path}`);
    }
    throw new Error(`Network error: ${path}`);
  }
}

export async function switchStrategy(marketConfigId: string, strategyVersionId: string) {
  return postApi('/api/v1/config/strategy', { marketConfigId, strategyVersionId });
}

export async function resetDefaultStrategy() {
  return postApi('/api/v1/config/strategy/reset-default', {});
}

export async function updateSystemConfig(update: Record<string, unknown>) {
  return postApi('/api/v1/config', update);
}

export async function toggleExecutionMode(currentMode: string) {
  const newMode = currentMode === 'paper' ? 'live' : 'paper';
  return postApi('/api/v1/config', { trading: { mode: newMode } });
}

export async function updateRiskConfig(config: {
  maxSizeUsd?: number;
  dailyLossLimitUsd?: number;
  maxSpreadBps?: number;
  minDepthScore?: number;
  maxTradesPerWindow?: number;
}) {
  return postApi('/api/v1/risk/config', config);
}

export async function setKillSwitch(active: boolean) {
  return postApi(`/api/v1/risk/kill-switch/${active ? 'on' : 'off'}`, {});
}

export async function setTradingMode(mode: 'disabled' | 'paper' | 'live') {
  return postApi('/api/v1/config', { trading: { mode } });
}

export async function updateTradingHours(hours: { enabled: boolean; startHour: number; endHour: number }) {
  return postApi('/api/v1/config', { trading: { tradingHoursUtc: hours } });
}

// ─── Config & Strategy API Functions ──────────────────────────────────────

export async function getSystemConfig() {
  return await fetchApi<Record<string, unknown>>('/api/v1/config');
}

export async function getStrategies() {
  return await fetchApi<Record<string, unknown>[]>('/api/v1/strategies');
}

export async function getStrategyDetail(id: string) {
  return await fetchApi<Record<string, unknown>>(`/api/v1/strategies/${id}`);
}

export async function getFeatureFlags() {
  return await fetchApi<Record<string, boolean>>('/api/v1/config/feature-flags');
}
