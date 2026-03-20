import { z } from 'zod';

// ─── Enums & Primitives ─────────────────────────────────────────────────────

export const MarketStatusSchema = z.enum(['active', 'paused', 'resolved', 'expired']);
export const WindowOutcomeSchema = z.enum(['up', 'down', 'flat', 'unknown']);
export const PriceSourceSchema = z.enum(['binance', 'coinbase', 'polymarket']);
export const AgentTypeSchema = z.enum(['regime', 'edge', 'supervisor']);
export const RegimeSchema = z.enum(['trending_up', 'trending_down', 'mean_reverting', 'volatile', 'quiet']);
export const EdgeDirectionSchema = z.enum(['up', 'down', 'none']);
export const SupervisorActionSchema = z.enum(['buy_up', 'buy_down', 'hold']);
export const ExecutionModeSchema = z.enum(['disabled', 'paper', 'live']);
export const OrderSideSchema = z.enum(['buy_up', 'buy_down']);
export const OrderStatusSchema = z.enum(['pending', 'placed', 'partial', 'filled', 'cancelled', 'failed']);
export const VolatilityRegimeSchema = z.enum(['low', 'medium', 'high']);
export const BookPressureSchema = z.enum(['bid', 'ask', 'neutral']);
export const BasisSignalSchema = z.enum(['long', 'short', 'neutral']);

// ─── Feature Payload Schema ─────────────────────────────────────────────────

export const MarketFeaturesSchema = z.object({
  windowId: z.string().uuid(),
  startPrice: z.number().min(0).max(1),
  elapsedMs: z.number().nonnegative(),
  remainingMs: z.number().nonnegative(),
});

export const PriceFeaturesSchema = z.object({
  currentPrice: z.number().positive(),
  returnBps: z.number(),
  volatility: z.number().nonnegative(),
  momentum: z.number(),
  meanReversionStrength: z.number(),
  tickRate: z.number().nonnegative(),
  binancePrice: z.number().positive(),
  coinbasePrice: z.number().positive(),
  exchangeMidPrice: z.number().positive(),
  polymarketMidPrice: z.number().min(0).max(1),
  basisBps: z.number(),
});

export const BookFeaturesSchema = z.object({
  upBid: z.number().min(0).max(1),
  upAsk: z.number().min(0).max(1),
  downBid: z.number().min(0).max(1),
  downAsk: z.number().min(0).max(1),
  spreadBps: z.number().nonnegative(),
  depthScore: z.number().nonnegative(),
  imbalance: z.number().min(-1).max(1),
});

export const SignalFeaturesSchema = z.object({
  priceDirectionScore: z.number().min(-1).max(1),
  volatilityRegime: VolatilityRegimeSchema,
  bookPressure: BookPressureSchema,
  basisSignal: BasisSignalSchema,
});

export const FeaturePayloadSchema = z.object({
  windowId: z.string().uuid(),
  eventTime: z.number().positive(),
  market: MarketFeaturesSchema,
  price: PriceFeaturesSchema,
  book: BookFeaturesSchema,
  signals: SignalFeaturesSchema,
});

// ─── Agent Output Schemas ───────────────────────────────────────────────────

export const RegimeOutputSchema = z.object({
  regime: RegimeSchema,
  confidence: z.number().min(0).max(1),
  reasoning: z.string().min(1).max(2000),
});

export const EdgeOutputSchema = z.object({
  direction: EdgeDirectionSchema,
  magnitude: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  reasoning: z.string().min(1).max(2000),
});

export const SupervisorOutputSchema = z.object({
  action: SupervisorActionSchema,
  sizeUsd: z.number().nonnegative(),
  confidence: z.number().min(0).max(1),
  reasoning: z.string().min(1).max(2000),
  regimeSummary: z.string().min(1).max(500),
  edgeSummary: z.string().min(1).max(500),
});

export const AgentDecisionSchema = z.object({
  id: z.string().uuid(),
  windowId: z.string().uuid(),
  agentType: AgentTypeSchema,
  input: z.record(z.unknown()),
  output: z.union([RegimeOutputSchema, EdgeOutputSchema, SupervisorOutputSchema]),
  model: z.string().min(1),
  provider: z.string().min(1),
  latencyMs: z.number().nonnegative(),
  eventTime: z.number().positive(),
  processedAt: z.number().positive(),
});

// ─── Risk Evaluation Schema ─────────────────────────────────────────────────

export const RiskConfigSchema = z.object({
  maxSizeUsd: z.number().positive(),
  dailyLossLimitUsd: z.number().positive(),
  maxSpreadBps: z.number().positive(),
  minDepthScore: z.number().nonnegative(),
  maxTradesPerWindow: z.number().int().positive(),
});

export const RiskStateSchema = z.object({
  dailyPnlUsd: z.number(),
  openPositionUsd: z.number().nonnegative(),
  tradesInWindow: z.number().int().nonnegative(),
  lastTradeTime: z.number().positive().nullable(),
});

export const RiskEvaluationSchema = z.object({
  id: z.string().uuid(),
  windowId: z.string().uuid(),
  agentDecisionId: z.string().uuid(),
  approved: z.boolean(),
  approvedSizeUsd: z.number().nonnegative(),
  rejectionReasons: z.array(z.string()),
  eventTime: z.number().positive(),
  processedAt: z.number().positive(),
});

// ─── Execution Request Schema ───────────────────────────────────────────────

export const ExecutionRequestSchema = z.object({
  windowId: z.string().uuid(),
  riskDecisionId: z.string().uuid(),
  side: OrderSideSchema,
  sizeUsd: z.number().positive(),
  entryPrice: z.number().min(0).max(1),
  mode: ExecutionModeSchema,
});

// ─── Config Schemas ─────────────────────────────────────────────────────────

export const AppConfigSchema = z.object({
  port: z.number().int().min(1).max(65535),
  env: z.enum(['development', 'staging', 'production']),
  mode: ExecutionModeSchema,
});

export const DatabaseConfigSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  user: z.string().min(1),
  password: z.string().min(1),
  database: z.string().min(1),
  ssl: z.boolean().default(false),
  poolSize: z.number().int().min(1).max(100).default(10),
});

export const PolymarketConfigSchema = z.object({
  apiUrl: z.string().url(),
  wsUrl: z.string().url(),
  apiKey: z.string().optional(),
  apiSecret: z.string().optional(),
  apiPassphrase: z.string().optional(),
});

export const PriceFeedConfigSchema = z.object({
  binanceWsUrl: z.string().url().default('wss://stream.binance.com:9443/ws'),
  coinbaseWsUrl: z.string().url().default('wss://ws-feed.exchange.coinbase.com'),
  symbol: z.string().default('BTCUSDT'),
  reconnectIntervalMs: z.number().int().positive().default(5000),
  maxReconnectAttempts: z.number().int().positive().default(10),
});

export const AgentConfigSchema = z.object({
  provider: z.enum(['anthropic', 'openai']),
  model: z.string().min(1),
  timeoutMs: z.number().int().positive().default(30000),
  maxRetries: z.number().int().nonnegative().default(2),
  temperature: z.number().min(0).max(2).default(0),
});

// ─── Type Inference Helpers ─────────────────────────────────────────────────

export type FeaturePayloadParsed = z.infer<typeof FeaturePayloadSchema>;
export type RegimeOutputParsed = z.infer<typeof RegimeOutputSchema>;
export type EdgeOutputParsed = z.infer<typeof EdgeOutputSchema>;
export type SupervisorOutputParsed = z.infer<typeof SupervisorOutputSchema>;
export type RiskEvaluationParsed = z.infer<typeof RiskEvaluationSchema>;
export type ExecutionRequestParsed = z.infer<typeof ExecutionRequestSchema>;
export type AppConfigParsed = z.infer<typeof AppConfigSchema>;
export type DatabaseConfigParsed = z.infer<typeof DatabaseConfigSchema>;
export type PolymarketConfigParsed = z.infer<typeof PolymarketConfigSchema>;
export type PriceFeedConfigParsed = z.infer<typeof PriceFeedConfigSchema>;
export type AgentConfigParsed = z.infer<typeof AgentConfigSchema>;
export type RiskConfigParsed = z.infer<typeof RiskConfigSchema>;

// ─── Validation Helpers ─────────────────────────────────────────────────────

export function validateFeaturePayload(data: unknown) {
  return FeaturePayloadSchema.parse(data);
}

export function validateRegimeOutput(data: unknown) {
  return RegimeOutputSchema.parse(data);
}

export function validateEdgeOutput(data: unknown) {
  return EdgeOutputSchema.parse(data);
}

export function validateSupervisorOutput(data: unknown) {
  return SupervisorOutputSchema.parse(data);
}

export function validateRiskEvaluation(data: unknown) {
  return RiskEvaluationSchema.parse(data);
}

export function validateExecutionRequest(data: unknown) {
  return ExecutionRequestSchema.parse(data);
}

export function safeValidate<T>(schema: z.ZodSchema<T>, data: unknown): { success: true; data: T } | { success: false; error: z.ZodError } {
  const result = schema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}
