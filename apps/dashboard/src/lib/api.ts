const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

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
    const res = await fetch(`${API_BASE}${path}`, { signal: controller.signal });
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
