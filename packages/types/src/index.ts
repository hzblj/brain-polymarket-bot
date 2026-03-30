// ─── Timestamp Helpers ───────────────────────────────────────────────────────

/** Unix milliseconds */
export type UnixMs = number;

/** ISO-8601 string */
export type ISOTimestamp = string;

export function nowMs(): UnixMs {
  return Date.now();
}

export function toISO(ms: UnixMs): ISOTimestamp {
  return new Date(ms).toISOString();
}

export function fromISO(iso: ISOTimestamp): UnixMs {
  return new Date(iso).getTime();
}

// ─── Market Types ────────────────────────────────────────────────────────────

export type MarketStatus = 'active' | 'paused' | 'resolved' | 'expired';

export interface Market {
  id: string;
  conditionId: string;
  slug: string;
  status: MarketStatus;
  createdAt: ISOTimestamp;
}

export type WindowOutcome = 'up' | 'down' | 'flat' | 'unknown';

export interface MarketWindow {
  id: string;
  marketId: string;
  startTime: UnixMs;
  endTime: UnixMs;
  startPrice: number;
  outcome: WindowOutcome;
  createdAt: ISOTimestamp;
}

// ─── Price Types ─────────────────────────────────────────────────────────────

export type PriceSource = 'binance' | 'coinbase' | 'polymarket';

export interface PriceTick {
  id: string;
  windowId: string;
  source: PriceSource;
  price: number;
  bid: number;
  ask: number;
  eventTime: UnixMs;
  ingestedAt: UnixMs;
}

export interface PriceWindow {
  ticks: PriceTick[];
  open: number;
  high: number;
  low: number;
  close: number;
  vwap: number;
  tickCount: number;
  durationMs: number;
}

export interface MicroStructure {
  volatility: number;
  momentum: number;
  meanReversionStrength: number;
  tickRate: number;
  spreadMean: number;
  spreadStdDev: number;
}

// ─── Orderbook Types ─────────────────────────────────────────────────────────

export interface BookLevel {
  price: number;
  size: number;
}

export interface BookSnapshot {
  id: string;
  windowId: string;
  upBid: number;
  upAsk: number;
  downBid: number;
  downAsk: number;
  spreadBps: number;
  depthScore: number;
  imbalance: number;
  eventTime: UnixMs;
  ingestedAt: UnixMs;
}

export interface BookMetrics {
  midPrice: number;
  spreadBps: number;
  bidDepthUsd: number;
  askDepthUsd: number;
  imbalance: number;
  depthScore: number;
}

// ─── Feature Types ───────────────────────────────────────────────────────────

export interface MarketFeatures {
  windowId: string;
  startPrice: number;
  elapsedMs: number;
  remainingMs: number;
}

export interface PriceFeatures {
  currentPrice: number;
  returnBps: number;
  volatility: number;
  momentum: number;
  meanReversionStrength: number;
  tickRate: number;
  binancePrice: number;
  coinbasePrice: number;
  exchangeMidPrice: number;
  polymarketMidPrice: number;
  basisBps: number;
}

export interface BookFeatures {
  upBid: number;
  upAsk: number;
  downBid: number;
  downAsk: number;
  spreadBps: number;
  depthScore: number;
  imbalance: number;
}

export interface SignalFeatures {
  priceDirectionScore: number;
  volatilityRegime: 'low' | 'medium' | 'high';
  bookPressure: 'bid' | 'ask' | 'neutral';
  basisSignal: 'long' | 'short' | 'neutral';
}

export interface FeaturePayload {
  windowId: string;
  eventTime: UnixMs;
  market: MarketFeatures;
  price: PriceFeatures;
  book: BookFeatures;
  signals: SignalFeatures;
}

// ─── Agent Types ─────────────────────────────────────────────────────────────

export type AgentType = 'regime' | 'edge' | 'supervisor';

export type Regime = 'trending_up' | 'trending_down' | 'mean_reverting' | 'volatile' | 'quiet';

export interface RegimeOutput {
  regime: Regime;
  confidence: number;
  reasoning: string;
}

export type EdgeDirection = 'up' | 'down' | 'none';

export interface EdgeOutput {
  direction: EdgeDirection;
  magnitude: number;
  confidence: number;
  reasoning: string;
}

export type SupervisorAction = 'buy_up' | 'buy_down' | 'hold';

export interface SupervisorOutput {
  action: SupervisorAction;
  sizeUsd: number;
  confidence: number;
  reasoning: string;
  regimeSummary: string;
  edgeSummary: string;
}

export interface AgentDecision {
  id: string;
  windowId: string;
  agentType: AgentType;
  input: Record<string, unknown>;
  output: RegimeOutput | EdgeOutput | SupervisorOutput;
  model: string;
  provider: string;
  latencyMs: number;
  eventTime: UnixMs;
  processedAt: UnixMs;
}

// ─── Risk Types ──────────────────────────────────────────────────────────────

export interface RiskConfig {
  maxSizeUsd: number;
  dailyLossLimitUsd: number;
  maxSpreadBps: number;
  minDepthScore: number;
  maxTradesPerWindow: number;
}

export interface RiskState {
  dailyPnlUsd: number;
  openPositionUsd: number;
  tradesInWindow: number;
  lastTradeTime: UnixMs | null;
}

export interface RiskEvaluation {
  id: string;
  windowId: string;
  agentDecisionId: string;
  approved: boolean;
  approvedSizeUsd: number;
  rejectionReasons: string[];
  eventTime: UnixMs;
  processedAt: UnixMs;
}

// ─── Execution Types ─────────────────────────────────────────────────────────

export type ExecutionMode = 'disabled' | 'paper' | 'live';

export type OrderSide = 'buy_up' | 'buy_down';

export type OrderStatus = 'pending' | 'placed' | 'partial' | 'filled' | 'cancelled' | 'failed';

export interface ExecutionRequest {
  windowId: string;
  riskDecisionId: string;
  side: OrderSide;
  sizeUsd: number;
  entryPrice: number;
  mode: ExecutionMode;
}

export interface Order {
  id: string;
  windowId: string;
  riskDecisionId: string;
  side: OrderSide;
  mode: ExecutionMode;
  sizeUsd: number;
  entryPrice: number;
  status: OrderStatus;
  polymarketOrderId: string | null;
  createdAt: ISOTimestamp;
  updatedAt: ISOTimestamp;
}

export interface Fill {
  id: string;
  orderId: string;
  fillPrice: number;
  fillSizeUsd: number;
  filledAt: ISOTimestamp;
}

// ─── Strategy Types ─────────────────────────────────────────────────────

export type StrategyStatus = 'active' | 'inactive' | 'archived';

export interface MarketConfig {
  id: string;
  label: string;
  asset: string;
  marketType: string;
  windowSec: number;
  resolverType: string;
  resolverSymbol: string;
  defaultEnabled: boolean;
  isActive: boolean;
  createdAt: ISOTimestamp;
  updatedAt: ISOTimestamp;
}

export interface Strategy {
  id: string;
  key: string;
  name: string;
  description: string;
  status: StrategyStatus;
  isDefault: boolean;
  createdAt: ISOTimestamp;
  updatedAt: ISOTimestamp;
}

export interface MarketSelector {
  asset: string;
  marketType: string;
  windowSec: number;
}

export interface AgentProfile {
  regimeAgentProfile: string;
  edgeAgentProfile: string;
  supervisorAgentProfile: string;
}

export interface DecisionPolicy {
  allowedDecisions: string[];
  minConfidence: number;
}

export interface StrategyFilters {
  maxSpreadBps: number;
  minDepthScore: number;
  minTimeToCloseSec: number;
  maxTimeToCloseSec: number;
}

export interface StrategyRiskProfile {
  maxSizeUsd: number;
  dailyLossLimitUsd: number;
  maxTradesPerWindow: number;
}

export interface StrategyExecutionPolicy {
  entryWindowStartSec: number;
  entryWindowEndSec: number;
  mode: ExecutionMode;
}

export interface StrategyVersionConfig {
  id: string;
  label: string;
  marketSelector: MarketSelector;
  agentProfile: AgentProfile;
  decisionPolicy: DecisionPolicy;
  filters: StrategyFilters;
  riskProfile: StrategyRiskProfile;
  executionPolicy: StrategyExecutionPolicy;
}

export interface StrategyVersion {
  id: string;
  strategyId: string;
  version: number;
  configJson: StrategyVersionConfig;
  checksum: string;
  createdAt: ISOTimestamp;
}

export interface StrategyAssignment {
  id: string;
  marketConfigId: string;
  strategyVersionId: string;
  priority: number;
  isActive: boolean;
  createdAt: ISOTimestamp;
  updatedAt: ISOTimestamp;
}

export interface StrategyRun {
  id: string;
  strategyVersionId: string;
  marketConfigId: string;
  decisionId: string | null;
  replayId: string | null;
  mode: ExecutionMode;
  createdAt: ISOTimestamp;
}

export interface ActiveStrategyContext {
  strategyKey: string;
  version: number;
  decisionPolicy: DecisionPolicy;
  filters: StrategyFilters;
  riskProfile: StrategyRiskProfile;
  executionPolicy: StrategyExecutionPolicy;
  agentProfile: AgentProfile;
}

// ─── Service Health ──────────────────────────────────────────────────────────

export type ServiceName =
  | 'market-discovery'
  | 'price-feed'
  | 'orderbook'
  | 'feature-engine'
  | 'agent-gateway'
  | 'risk'
  | 'execution'
  | 'replay'
  | 'config'
  | 'api-gateway';

export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy';

export interface ServiceHealthLog {
  id: string;
  service: ServiceName;
  status: HealthStatus;
  details: Record<string, unknown>;
  checkedAt: ISOTimestamp;
}

// ─── Replay Types ────────────────────────────────────────────────────────────

export interface ReplayConfig {
  fromTime: UnixMs;
  toTime: UnixMs;
  speedMultiplier: number;
  mode: ExecutionMode;
}

export interface ReplayResults {
  totalWindows: number;
  totalTrades: number;
  pnlUsd: number;
  winRate: number;
  avgLatencyMs: number;
}

export interface Replay {
  id: string;
  fromTime: UnixMs;
  toTime: UnixMs;
  config: ReplayConfig;
  results: ReplayResults | null;
  createdAt: ISOTimestamp;
}
