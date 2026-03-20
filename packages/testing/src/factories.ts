import { randomUUID } from 'crypto';
import type {
  Market,
  MarketWindow,
  PriceTick,
  BookSnapshot,
  FeaturePayload,
  RegimeOutput,
  EdgeOutput,
  SupervisorOutput,
  AgentDecision,
  RiskEvaluation,
  ExecutionRequest,
  Order,
  Fill,
  UnixMs,
} from '@brain/types';

let counter = 0;
function nextId(): string {
  return randomUUID();
}

function nowMs(): UnixMs {
  return Date.now();
}

export function createTestMarket(overrides: Partial<Market> = {}): Market {
  return {
    id: nextId(),
    conditionId: `0x${(++counter).toString(16).padStart(64, '0')}`,
    slug: `will-btc-go-up-${counter}`,
    status: 'active',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

export function createTestMarketWindow(overrides: Partial<MarketWindow> = {}): MarketWindow {
  const now = nowMs();
  return {
    id: nextId(),
    marketId: nextId(),
    startTime: now,
    endTime: now + 5 * 60 * 1000,
    startPrice: 0.5,
    outcome: 'unknown',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

export function createTestPriceTick(overrides: Partial<PriceTick> = {}): PriceTick {
  const price = 67500 + Math.random() * 100;
  return {
    id: nextId(),
    windowId: nextId(),
    source: 'binance',
    price,
    bid: price - 0.5,
    ask: price + 0.5,
    eventTime: nowMs(),
    ingestedAt: nowMs(),
    ...overrides,
  };
}

export function createTestBookSnapshot(overrides: Partial<BookSnapshot> = {}): BookSnapshot {
  return {
    id: nextId(),
    windowId: nextId(),
    upBid: 0.52,
    upAsk: 0.54,
    downBid: 0.46,
    downAsk: 0.48,
    spreadBps: 200,
    depthScore: 0.75,
    imbalance: 0.1,
    eventTime: nowMs(),
    ingestedAt: nowMs(),
    ...overrides,
  };
}

export function createTestFeaturePayload(overrides: Partial<FeaturePayload> = {}): FeaturePayload {
  const windowId = overrides.windowId ?? nextId();
  return {
    windowId,
    eventTime: nowMs(),
    market: {
      windowId,
      startPrice: 0.5,
      elapsedMs: 120000,
      remainingMs: 180000,
      ...overrides.market,
    },
    price: {
      currentPrice: 67550,
      returnBps: 15,
      volatility: 0.02,
      momentum: 0.3,
      meanReversionStrength: -0.1,
      tickRate: 12,
      binancePrice: 67548,
      coinbasePrice: 67552,
      exchangeMidPrice: 67550,
      polymarketMidPrice: 0.53,
      basisBps: 50,
      ...overrides.price,
    },
    book: {
      upBid: 0.52,
      upAsk: 0.54,
      downBid: 0.46,
      downAsk: 0.48,
      spreadBps: 200,
      depthScore: 0.75,
      imbalance: 0.1,
      ...overrides.book,
    },
    signals: {
      priceDirectionScore: 0.3,
      volatilityRegime: 'medium',
      bookPressure: 'bid',
      basisSignal: 'neutral',
      ...overrides.signals,
    },
    ...overrides,
  };
}

export function createTestRegimeOutput(overrides: Partial<RegimeOutput> = {}): RegimeOutput {
  return {
    regime: 'trending_up',
    confidence: 0.75,
    reasoning: 'BTC showing sustained upward momentum with increasing volume and positive microstructure signals.',
    ...overrides,
  };
}

export function createTestEdgeOutput(overrides: Partial<EdgeOutput> = {}): EdgeOutput {
  return {
    direction: 'up',
    magnitude: 0.6,
    confidence: 0.7,
    reasoning: 'Exchange price momentum aligns with positive book imbalance and favorable basis.',
    ...overrides,
  };
}

export function createTestSupervisorOutput(overrides: Partial<SupervisorOutput> = {}): SupervisorOutput {
  return {
    action: 'buy_up',
    sizeUsd: 25,
    confidence: 0.65,
    reasoning: 'Regime and edge analysis agree on upward direction with moderate confidence. Sizing conservatively given spread.',
    regimeSummary: 'Trending up with 0.75 confidence',
    edgeSummary: 'Up edge at 0.6 magnitude with 0.7 confidence',
    ...overrides,
  };
}

export function createTestAgentDecision(overrides: Partial<AgentDecision> = {}): AgentDecision {
  return {
    id: nextId(),
    windowId: nextId(),
    agentType: 'supervisor',
    input: { features: createTestFeaturePayload() },
    output: createTestSupervisorOutput(),
    model: 'claude-sonnet-4-20250514',
    provider: 'anthropic',
    latencyMs: 2500,
    eventTime: nowMs(),
    processedAt: nowMs(),
    ...overrides,
  };
}

export function createTestRiskEvaluation(overrides: Partial<RiskEvaluation> = {}): RiskEvaluation {
  return {
    id: nextId(),
    windowId: nextId(),
    agentDecisionId: nextId(),
    approved: true,
    approvedSizeUsd: 25,
    rejectionReasons: [],
    eventTime: nowMs(),
    processedAt: nowMs(),
    ...overrides,
  };
}

export function createTestExecutionRequest(overrides: Partial<ExecutionRequest> = {}): ExecutionRequest {
  return {
    windowId: nextId(),
    riskDecisionId: nextId(),
    side: 'buy_up',
    sizeUsd: 25,
    entryPrice: 0.53,
    mode: 'paper',
    ...overrides,
  };
}

export function createTestOrder(overrides: Partial<Order> = {}): Order {
  const now = new Date().toISOString();
  return {
    id: nextId(),
    windowId: nextId(),
    riskDecisionId: nextId(),
    side: 'buy_up',
    mode: 'paper',
    sizeUsd: 25,
    entryPrice: 0.53,
    status: 'filled',
    polymarketOrderId: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function createTestFill(overrides: Partial<Fill> = {}): Fill {
  return {
    id: nextId(),
    orderId: nextId(),
    fillPrice: 0.53,
    fillSizeUsd: 25,
    filledAt: new Date().toISOString(),
    ...overrides,
  };
}
