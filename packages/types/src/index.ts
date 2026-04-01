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

// ─── Whale Types ────────────────────────────────────────────────────────────

export type WhaleFlowDirection = 'exchange_inflow' | 'exchange_outflow' | 'unknown';

export interface WhaleTransaction {
  txid: string;
  amountBtc: number;
  amountUsd: number;
  direction: WhaleFlowDirection;
  fromAddress: string;
  toAddress: string;
  isExchangeInflow: boolean;
  isExchangeOutflow: boolean;
  eventTime: UnixMs;
}

export interface WhaleFeatures {
  /** Number of large transactions (>10 BTC) in the current window */
  largeTransactionCount: number;
  /** Net BTC flow to exchanges (positive = inflow = bearish, negative = outflow = bullish) */
  netExchangeFlowBtc: number;
  /** Normalized exchange flow pressure: -1 (strong outflow/bullish) to 1 (strong inflow/bearish) */
  exchangeFlowPressure: number;
  /** Total BTC volume of whale transactions in the window */
  whaleVolumeBtc: number;
  /** 0-1 score: how abnormal is current whale activity vs recent history */
  abnormalActivityScore: number;
  /** Timestamp of last whale transaction seen */
  lastWhaleEventTime: UnixMs | null;
}

export interface WhaleSnapshot {
  id: string;
  windowId: string;
  features: WhaleFeatures;
  recentTransactions: WhaleTransaction[];
  eventTime: UnixMs;
  ingestedAt: UnixMs;
}

export interface BlockchainActivity {
  /** Rolling 1h window stats */
  window: {
    durationMs: number;
    startTime: UnixMs;
  };
  /** Mempool state */
  mempool: {
    txCount: number;
    totalFeeBtc: number;
    vsize: number;
  };
  /** Recommended fee rates (sat/vB) */
  fees: {
    fastest: number;
    halfHour: number;
    hour: number;
    economy: number;
    minimum: number;
  };
  /** Recent confirmed block stats */
  latestBlock: {
    height: number;
    txCount: number;
    size: number;
    timestamp: UnixMs;
  } | null;
  /** Notable transactions (>1 BTC) in the last hour */
  notableTransactions: {
    total: number;
    totalBtc: number;
    totalUsd: number;
    exchangeInflows: { count: number; btc: number };
    exchangeOutflows: { count: number; btc: number };
    largest: { txid: string; amountBtc: number; amountUsd: number; direction: WhaleFlowDirection } | null;
  };
  /** Activity trend vs previous hour */
  trend: {
    txCountChange: number;
    volumeChange: number;
    feeChange: number;
  };
  lastUpdated: UnixMs;
}

// ─── Derivatives Types ──────────────────────────────────────────────────────

export interface FundingRateData {
  symbol: string;
  fundingRate: number;
  fundingTime: UnixMs;
  markPrice: number;
  indexPrice: number;
}

export interface OpenInterestData {
  symbol: string;
  openInterestBtc: number;
  openInterestUsd: number;
  eventTime: UnixMs;
}

export interface LiquidationEvent {
  symbol: string;
  side: 'buy' | 'sell';
  price: number;
  quantity: number;
  quantityUsd: number;
  eventTime: UnixMs;
}

export interface DerivativesFeatures {
  /** Current funding rate (positive = longs pay shorts = bearish, negative = bullish) */
  fundingRate: number;
  /** Funding rate annualized percentage */
  fundingRateAnnualized: number;
  /** Funding rate signal: -1 (extreme negative) to 1 (extreme positive) */
  fundingPressure: number;
  /** Total open interest in USD */
  openInterestUsd: number;
  /** OI change over last 5 minutes in percent */
  openInterestChangePct: number;
  /** OI trend signal: -1 (rapidly decreasing) to 1 (rapidly increasing) */
  oiTrend: number;
  /** Total long liquidation volume in USD over rolling window */
  longLiquidationUsd: number;
  /** Total short liquidation volume in USD over rolling window */
  shortLiquidationUsd: number;
  /** Net liquidation pressure: positive = more longs liquidated (bearish), negative = more shorts (bullish) */
  liquidationImbalance: number;
  /** 0-1 score: how extreme is current liquidation activity vs baseline */
  liquidationIntensity: number;
  /** Composite derivatives sentiment: -1 (bearish) to 1 (bullish) */
  derivativesSentiment: number;
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
  /** Total USD liquidity on bid side */
  bidDepthUsd?: number;
  /** Total USD liquidity on ask side */
  askDepthUsd?: number;
}

export interface SignalFeatures {
  priceDirectionScore: number;
  volatilityRegime: 'low' | 'medium' | 'high';
  bookPressure: 'bid' | 'ask' | 'neutral';
  basisSignal: 'long' | 'short' | 'neutral';
  tradeable: boolean;
}

export interface FeaturePayload {
  windowId: string;
  eventTime: UnixMs;
  market: MarketFeatures;
  price: PriceFeatures;
  book: BookFeatures;
  signals: SignalFeatures;
  whales?: WhaleFeatures;
  derivatives?: DerivativesFeatures;
  blockchain?: BlockchainActivity;
}

// ─── Agent Types ─────────────────────────────────────────────────────────────

export type AgentType = 'regime' | 'edge' | 'supervisor' | 'validator' | 'gatekeeper' | 'eval';

export type PatchableAgent = 'regime' | 'edge' | 'supervisor';

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

export interface ValidatorOutput {
  valid: boolean;
  issues: string[];
}

export interface GatekeeperOutput {
  validated: boolean;
  adjustedSizeUsd?: number;
  reasoning: string;
}

export type PatchType = 'replace' | 'insert_after';

export interface EvalOutput {
  targetAgent: PatchableAgent;
  patchType: PatchType;
  oldText: string;
  newText: string;
  reasoning: string;
  confidence: number;
}

export interface PromptPatch {
  id: string;
  orderId: string;
  windowId: string;
  agentDecisionId: string;
  targetAgent: PatchableAgent;
  patchType: PatchType;
  oldText: string;
  newText: string;
  reasoning: string;
  confidence: number;
  status: 'pending' | 'approved' | 'rejected' | 'applied';
  createdAt: string;
  reviewedAt: string | null;
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
  | 'api-gateway'
  | 'whale-tracker'
  | 'derivatives-feed'
  | 'post-trade-analyzer'
  | 'strategy-optimizer';

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

// ─── Trade Analysis Types ───────────────────────────────────────────────────

export type AnalysisVerdict = 'profitable' | 'unprofitable' | 'breakeven' | 'unknown';
export type ConfidenceCalibration = 'overconfident' | 'underconfident' | 'well_calibrated';

export interface TradeAnalysis {
  id: string;
  windowId: string;
  orderId: string;
  verdict: AnalysisVerdict;
  pnlUsd: number;
  pnlBps: number;
  entryPrice: number;
  exitPrice: number;
  side: OrderSide;
  sizeUsd: number;
  regimeAtEntry: Regime;
  edgeDirectionAtEntry: EdgeDirection;
  edgeMagnitudeAtEntry: number;
  supervisorConfidence: number;
  edgeAccurate: boolean;
  confidenceCalibration: ConfidenceCalibration;
  misleadingSignals: string[];
  correctSignals: string[];
  improvementSuggestions: string[];
  llmReasoning: string;
  model: string;
  provider: string;
  latencyMs: number;
  createdAt: ISOTimestamp;
}

// ─── Strategy Report Types ──────────────────────────────────────────────────

export type SuggestionCategory =
  | 'risk_limits'
  | 'position_sizing'
  | 'agent_prompts'
  | 'regime_filters'
  | 'timing'
  | 'other';

export type SuggestionPriority = 'high' | 'medium' | 'low';

export interface StrategySuggestion {
  category: SuggestionCategory;
  suggestion: string;
  rationale: string;
  confidence: number;
  priority: SuggestionPriority;
  autoApplicable: boolean;
}

export interface RegimePerformance {
  trades: number;
  pnlUsd: number;
  winRate: number;
}

export interface HourPerformance {
  trades: number;
  pnlUsd: number;
}

export interface AgentAccuracyMetrics {
  edgePredictionAccuracy: number;
  confidenceCalibration: number;
  regimeAccuracy: number;
}

export interface RiskMetrics {
  rejectionRate: number;
  topRejectionReasons: string[];
}

export interface DailyReport {
  id: string;
  periodStart: ISOTimestamp;
  periodEnd: ISOTimestamp;
  totalTrades: number;
  totalPnlUsd: number;
  winRate: number;
  avgEdgeMagnitude: number;
  maxDrawdownUsd: number;
  performanceByRegime: Record<string, RegimePerformance>;
  performanceByHour: Record<string, HourPerformance>;
  agentAccuracy: AgentAccuracyMetrics;
  riskMetrics: RiskMetrics;
  patterns: string[];
  suggestions: StrategySuggestion[];
  executiveSummary: string;
  llmReasoning: string;
  model: string;
  provider: string;
  latencyMs: number;
  createdAt: ISOTimestamp;
}
