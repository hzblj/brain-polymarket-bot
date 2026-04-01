import { createDb } from '@brain/database';
import { EventBus } from '@brain/events';
import type {
  EdgeOutput,
  FeaturePayload,
  RegimeOutput,
  RiskConfig,
  RiskState,
  SupervisorOutput,
} from '@brain/types';
import { HttpException } from '@nestjs/common';
import type { z } from 'zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentGatewayService } from './agent-gateway.service';

// ─── Mock LLM Client ─────────────────────────────────────────────────────────

function createMockLlmClient() {
  const stubResponses: Record<string, unknown> = {
    regime: {
      regime: 'mean_reverting',
      confidence: 0.55,
      reasoning: 'Price shows moderate mean reversion strength with low directional momentum.',
    },
    edge: {
      direction: 'none',
      magnitude: 0,
      confidence: 0.4,
      reasoning: 'No significant edge detected.',
    },
    supervisor: {
      action: 'hold',
      sizeUsd: 0,
      confidence: 0.5,
      reasoning: 'Holding. No clear edge detected.',
      regimeSummary: 'Market is in a mean-reverting regime.',
      edgeSummary: 'No actionable edge identified.',
    },
  };

  return {
    provider: 'openai',
    evaluate: vi.fn(async (systemPrompt: string, _userPrompt: string, schema: z.ZodSchema) => {
      // Detect agent type from system prompt
      let agentType = 'supervisor';
      if (systemPrompt.startsWith('You are a market regime classification')) agentType = 'regime';
      else if (systemPrompt.startsWith('You are an edge estimation')) agentType = 'edge';

      const data = schema.parse(stubResponses[agentType]);
      return {
        data,
        model: 'gpt-4o',
        provider: 'openai',
        latencyMs: 150,
        inputTokens: 500,
        outputTokens: 100,
      };
    }),
  };
}

// ─── Mock Logger ──────────────────────────────────────────────────────────────

function createMockLogger(): any {
  const noop = () => {};
  const logger = { log: noop, info: noop, error: noop, warn: noop, debug: noop, verbose: noop, fatal: noop, child: () => logger };
  return logger;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeFeaturePayload(overrides: Partial<FeaturePayload> = {}): FeaturePayload {
  return {
    windowId: '550e8400-e29b-41d4-a716-446655440000',
    eventTime: 1700000000000,
    market: {
      windowId: '550e8400-e29b-41d4-a716-446655440000',
      startPrice: 0.5,
      elapsedMs: 120_000,
      remainingMs: 180_000,
    },
    price: {
      currentPrice: 67_500,
      returnBps: 15,
      volatility: 0.02,
      momentum: 0.3,
      meanReversionStrength: 0.1,
      tickRate: 5,
      binancePrice: 67_500,
      coinbasePrice: 67_490,
      exchangeMidPrice: 67_495,
      polymarketMidPrice: 0.52,
      basisBps: 10,
    },
    book: {
      upBid: 0.48,
      upAsk: 0.52,
      downBid: 0.47,
      downAsk: 0.53,
      spreadBps: 400,
      depthScore: 0.8,
      imbalance: 0.1,
    },
    signals: {
      priceDirectionScore: 0.3,
      volatilityRegime: 'medium',
      bookPressure: 'neutral',
      basisSignal: 'neutral',
      tradeable: true,
    },
    ...overrides,
  };
}

function makeRegimeOutput(overrides: Partial<RegimeOutput> = {}): RegimeOutput {
  return {
    regime: 'trending_up',
    confidence: 0.7,
    reasoning: 'Strong upward momentum with positive return.',
    ...overrides,
  };
}

function makeEdgeOutput(overrides: Partial<EdgeOutput> = {}): EdgeOutput {
  return {
    direction: 'up',
    magnitude: 0.08,
    confidence: 0.65,
    reasoning: 'Fair value exceeds market price.',
    ...overrides,
  };
}

function makeRiskState(overrides: Partial<RiskState> = {}): RiskState {
  return {
    dailyPnlUsd: 5,
    openPositionUsd: 0,
    tradesInWindow: 0,
    lastTradeTime: null,
    ...overrides,
  };
}

function makeRiskConfig(overrides: Partial<RiskConfig> = {}): RiskConfig {
  return {
    maxSizeUsd: 30,
    dailyLossLimitUsd: 50,
    maxSpreadBps: 500,
    minDepthScore: 0.3,
    maxTradesPerWindow: 3,
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('AgentGatewayService', () => {
  let service: AgentGatewayService;

  beforeEach(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {
      /* noop */
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {
      /* noop */
    });
    vi.spyOn(console, 'error').mockImplementation(() => {
      /* noop */
    });

    const db = createDb(':memory:');
    const eventBus = new EventBus();
    const mockClient = createMockLlmClient();
    const mockLogger = createMockLogger();
    service = new AgentGatewayService(db, eventBus, mockClient as any, mockLogger);
    await service.onModuleInit();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─── evaluateRegime ────────────────────────────────────────────────────────

  describe('evaluateRegime', () => {
    it('returns a trace with valid regime output shape', async () => {
      const features = makeFeaturePayload();
      const trace = await service.evaluateRegime({
        windowId: 'win-001',
        features,
      });

      expect(trace).toBeDefined();
      expect(trace.id).toMatch(/^trace-/);
      expect(trace.windowId).toBe('win-001');
      expect(trace.agentType).toBe('regime');
      expect(trace.cached).toBe(false);
    });

    it('parsedOutput contains regime, confidence, and reasoning', async () => {
      const trace = await service.evaluateRegime({
        windowId: 'win-002',
        features: makeFeaturePayload(),
      });

      const output = trace.parsedOutput as RegimeOutput;
      expect(output).toHaveProperty('regime');
      expect(output).toHaveProperty('confidence');
      expect(output).toHaveProperty('reasoning');
      expect(['trending_up', 'trending_down', 'mean_reverting', 'volatile', 'quiet']).toContain(
        output.regime,
      );
      expect(output.confidence).toBeGreaterThanOrEqual(0);
      expect(output.confidence).toBeLessThanOrEqual(1);
      expect(typeof output.reasoning).toBe('string');
      expect(output.reasoning.length).toBeGreaterThan(0);
    });

    it('includes correct model and provider metadata', async () => {
      const trace = await service.evaluateRegime({
        windowId: 'win-003',
        features: makeFeaturePayload(),
      });

      expect(trace.model).toBe('gpt-4o');
      expect(trace.provider).toBe('openai');
    });

    it('records non-negative latency', async () => {
      const trace = await service.evaluateRegime({
        windowId: 'win-004',
        features: makeFeaturePayload(),
      });

      expect(trace.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('records token usage with positive values', async () => {
      const trace = await service.evaluateRegime({
        windowId: 'win-005',
        features: makeFeaturePayload(),
      });

      expect(trace.tokenUsage.input).toBeGreaterThan(0);
      expect(trace.tokenUsage.output).toBeGreaterThan(0);
    });

    it('includes the user prompt with feature data', async () => {
      const features = makeFeaturePayload();
      const trace = await service.evaluateRegime({
        windowId: 'win-006',
        features,
      });

      const prompt = JSON.parse(trace.userPrompt);
      expect(prompt.windowId).toBe(features.windowId);
      expect(prompt.price.currentPrice).toBe(features.price.currentPrice);
      expect(prompt.book.spreadBps).toBe(features.book.spreadBps);
      expect(prompt.signals).toEqual(features.signals);
    });

    it('uses the regime system prompt', async () => {
      const trace = await service.evaluateRegime({
        windowId: 'win-007',
        features: makeFeaturePayload(),
      });

      expect(trace.systemPrompt).toContain('market regime classification agent');
    });
  });

  // ─── evaluateEdge ──────────────────────────────────────────────────────────

  describe('evaluateEdge', () => {
    it('returns a trace with valid edge output shape', async () => {
      const trace = await service.evaluateEdge({
        windowId: 'win-010',
        features: makeFeaturePayload(),
      });

      expect(trace).toBeDefined();
      expect(trace.agentType).toBe('edge');

      const output = trace.parsedOutput as EdgeOutput;
      expect(output).toHaveProperty('direction');
      expect(output).toHaveProperty('magnitude');
      expect(output).toHaveProperty('confidence');
      expect(output).toHaveProperty('reasoning');
    });

    it('edge direction is one of up, down, none', async () => {
      const trace = await service.evaluateEdge({
        windowId: 'win-011',
        features: makeFeaturePayload(),
      });

      const output = trace.parsedOutput as EdgeOutput;
      expect(['up', 'down', 'none']).toContain(output.direction);
    });

    it('magnitude is between 0 and 1', async () => {
      const trace = await service.evaluateEdge({
        windowId: 'win-012',
        features: makeFeaturePayload(),
      });

      const output = trace.parsedOutput as EdgeOutput;
      expect(output.magnitude).toBeGreaterThanOrEqual(0);
      expect(output.magnitude).toBeLessThanOrEqual(1);
    });

    it('user prompt includes orderbook and basis data', async () => {
      const features = makeFeaturePayload();
      const trace = await service.evaluateEdge({
        windowId: 'win-013',
        features,
      });

      const prompt = JSON.parse(trace.userPrompt);
      expect(prompt.book.upBid).toBe(features.book.upBid);
      expect(prompt.book.upAsk).toBe(features.book.upAsk);
      expect(prompt.price.basisBps).toBe(features.price.basisBps);
      expect(prompt.price.exchangeMidPrice).toBe(features.price.exchangeMidPrice);
    });

    it('uses the edge system prompt', async () => {
      const trace = await service.evaluateEdge({
        windowId: 'win-014',
        features: makeFeaturePayload(),
      });

      expect(trace.systemPrompt).toContain('edge estimation agent');
    });
  });

  // ─── evaluateSupervisor ────────────────────────────────────────────────────

  describe('evaluateSupervisor', () => {
    it('returns a trace with valid supervisor output shape', async () => {
      const trace = await service.evaluateSupervisor({
        windowId: 'win-020',
        features: makeFeaturePayload(),
        regime: makeRegimeOutput(),
        edge: makeEdgeOutput(),
        riskState: makeRiskState(),
        riskConfig: makeRiskConfig(),
      });

      expect(trace).toBeDefined();
      expect(trace.agentType).toBe('supervisor');

      const output = trace.parsedOutput as SupervisorOutput;
      expect(output).toHaveProperty('action');
      expect(output).toHaveProperty('sizeUsd');
      expect(output).toHaveProperty('confidence');
      expect(output).toHaveProperty('reasoning');
      expect(output).toHaveProperty('regimeSummary');
      expect(output).toHaveProperty('edgeSummary');
    });

    it('action is one of buy_up, buy_down, hold', async () => {
      const trace = await service.evaluateSupervisor({
        windowId: 'win-021',
        features: makeFeaturePayload(),
        regime: makeRegimeOutput(),
        edge: makeEdgeOutput(),
        riskState: makeRiskState(),
        riskConfig: makeRiskConfig(),
      });

      const output = trace.parsedOutput as SupervisorOutput;
      expect(['buy_up', 'buy_down', 'hold']).toContain(output.action);
    });

    it('sizeUsd is non-negative', async () => {
      const trace = await service.evaluateSupervisor({
        windowId: 'win-022',
        features: makeFeaturePayload(),
        regime: makeRegimeOutput(),
        edge: makeEdgeOutput(),
        riskState: makeRiskState(),
        riskConfig: makeRiskConfig(),
      });

      const output = trace.parsedOutput as SupervisorOutput;
      expect(output.sizeUsd).toBeGreaterThanOrEqual(0);
    });

    it('user prompt includes regime, edge, and risk data', async () => {
      const regime = makeRegimeOutput();
      const edge = makeEdgeOutput();
      const riskState = makeRiskState({ dailyPnlUsd: -10 });
      const riskConfig = makeRiskConfig({ maxSizeUsd: 25 });

      const trace = await service.evaluateSupervisor({
        windowId: 'win-023',
        features: makeFeaturePayload(),
        regime,
        edge,
        riskState,
        riskConfig,
      });

      const prompt = JSON.parse(trace.userPrompt);
      expect(prompt.regime.regime).toBe(regime.regime);
      expect(prompt.regime.confidence).toBe(regime.confidence);
      expect(prompt.edge.direction).toBe(edge.direction);
      expect(prompt.edge.magnitude).toBe(edge.magnitude);
      expect(prompt.risk.dailyPnlUsd).toBe(-10);
      expect(prompt.risk.maxSizeUsd).toBe(25);
    });

    it('uses the supervisor system prompt', async () => {
      const trace = await service.evaluateSupervisor({
        windowId: 'win-024',
        features: makeFeaturePayload(),
        regime: makeRegimeOutput(),
        edge: makeEdgeOutput(),
        riskState: makeRiskState(),
        riskConfig: makeRiskConfig(),
      });

      expect(trace.systemPrompt).toContain('supervisor agent');
    });
  });

  // ─── Trace storage ─────────────────────────────────────────────────────────

  describe('listTraces / getTrace', () => {
    it('stores traces and retrieves them via listTraces', async () => {
      await service.evaluateRegime({ windowId: 'win-030', features: makeFeaturePayload() });
      await service.evaluateEdge({ windowId: 'win-030', features: makeFeaturePayload() });

      const all = await service.listTraces();
      expect(all.length).toBe(2);
    });

    it('filters traces by agentType', async () => {
      await service.evaluateRegime({ windowId: 'win-031', features: makeFeaturePayload() });
      await service.evaluateEdge({ windowId: 'win-031', features: makeFeaturePayload() });

      const regimeTraces = await service.listTraces('regime');
      expect(regimeTraces.length).toBe(1);
      expect(regimeTraces[0]?.agentType).toBe('regime');
    });

    it('filters traces by windowId', async () => {
      await service.evaluateRegime({ windowId: 'win-032a', features: makeFeaturePayload() });
      await service.evaluateRegime({
        windowId: 'win-032b',
        features: makeFeaturePayload({ eventTime: 1700000001000 }),
      });

      const traces = await service.listTraces(undefined, 'win-032a');
      expect(traces.length).toBe(1);
      expect(traces[0]?.windowId).toBe('win-032a');
    });

    it('respects the limit parameter', async () => {
      for (let i = 0; i < 5; i++) {
        await service.evaluateRegime({
          windowId: `win-033-${i}`,
          features: makeFeaturePayload({ eventTime: 1700000000000 + i * 1000 }),
        });
      }

      const traces = await service.listTraces(undefined, undefined, 3);
      expect(traces.length).toBe(3);
    });

    it('returns traces sorted by createdAt descending', async () => {
      for (let i = 0; i < 3; i++) {
        await service.evaluateRegime({
          windowId: `win-034-${i}`,
          features: makeFeaturePayload({ eventTime: 1700000000000 + i * 1000 }),
        });
      }

      const traces = await service.listTraces();
      for (let i = 1; i < traces.length; i++) {
        expect(new Date(traces[i - 1]!.createdAt).getTime()).toBeGreaterThanOrEqual(
          new Date(traces[i]!.createdAt).getTime(),
        );
      }
    });

    it('getTrace retrieves a specific trace by ID', async () => {
      const trace = await service.evaluateRegime({
        windowId: 'win-035',
        features: makeFeaturePayload(),
      });

      const retrieved = await service.getTrace(trace.id);
      expect(retrieved.id).toBe(trace.id);
      expect(retrieved.windowId).toBe('win-035');
    });

    it('getTrace throws HttpException for unknown ID', async () => {
      await expect(service.getTrace('nonexistent-id')).rejects.toThrow(HttpException);
      await expect(service.getTrace('nonexistent-id')).rejects.toThrow('not found');
    });
  });

  // ─── Caching ───────────────────────────────────────────────────────────────

  describe('caching', () => {
    it('returns cached result for identical request within cache window', async () => {
      const features = makeFeaturePayload();

      const first = await service.evaluateRegime({ windowId: 'win-040', features });
      const second = await service.evaluateRegime({ windowId: 'win-040', features });

      expect(second.cached).toBe(true);
      expect(second.id).toBe(first.id);
    });

    it('does not return cached result for different windowId', async () => {
      const features = makeFeaturePayload();

      const first = await service.evaluateRegime({ windowId: 'win-041a', features });
      const second = await service.evaluateRegime({ windowId: 'win-041b', features });

      expect(second.cached).toBe(false);
      expect(second.id).not.toBe(first.id);
    });

    it('does not return cached result for different eventTime (different second)', async () => {
      const features1 = makeFeaturePayload({ eventTime: 1700000000000 });
      const features2 = makeFeaturePayload({ eventTime: 1700000002000 });

      const first = await service.evaluateRegime({ windowId: 'win-042', features: features1 });
      const second = await service.evaluateRegime({ windowId: 'win-042', features: features2 });

      expect(second.cached).toBe(false);
      expect(second.id).not.toBe(first.id);
    });

    it('cache key rounds eventTime to nearest second', async () => {
      const features1 = makeFeaturePayload({ eventTime: 1700000000100 });
      const features2 = makeFeaturePayload({ eventTime: 1700000000900 });

      const _first = await service.evaluateRegime({ windowId: 'win-043', features: features1 });
      const second = await service.evaluateRegime({ windowId: 'win-043', features: features2 });

      // Both round to 1700000000000, so second should be cached
      expect(second.cached).toBe(true);
    });

    it('cache expires after TTL', async () => {
      const features = makeFeaturePayload();

      const _first = await service.evaluateRegime({ windowId: 'win-044', features });

      // Simulate cache expiration by advancing time
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 6_000);

      const second = await service.evaluateRegime({ windowId: 'win-044', features });
      expect(second.cached).toBe(false);
    });

    it('caches work independently per agent type', async () => {
      const features = makeFeaturePayload();

      const regimeTrace = await service.evaluateRegime({ windowId: 'win-045', features });
      const edgeTrace = await service.evaluateEdge({ windowId: 'win-045', features });

      // Same windowId/eventTime but different agent type - no cache hit
      expect(edgeTrace.cached).toBe(false);
      expect(edgeTrace.agentType).toBe('edge');
      expect(regimeTrace.agentType).toBe('regime');
    });
  });

  // ─── getContext ──────────────────────────────────────────────────────────────

  describe('getContext', () => {
    it('returns provider, model, and cache info', async () => {
      const context = await service.getContext();
      expect(context.provider).toBe('openai');
      expect(context.model).toBe('gpt-5.4');
      expect(context.cacheSize).toBe(0);
      expect(context.tracesInMemory).toBe(0);
    });

    it('reflects traces after evaluations', async () => {
      await service.evaluateRegime({ windowId: 'win-ctx-1', features: makeFeaturePayload() });
      const context = await service.getContext();
      expect(context.tracesInMemory).toBe(1);
      expect((context.recentTraces as unknown[]).length).toBe(1);
    });
  });

  // ─── validateDecision ─────────────────────────────────────────────────────

  describe('validateDecision', () => {
    it('validates a correct supervisor output', async () => {
      const result = await service.validateDecision({
        action: 'hold',
        sizeUsd: 0,
        confidence: 0.5,
        reasoning: 'No edge.',
        regimeSummary: 'Quiet market.',
        edgeSummary: 'No edge found.',
      });
      expect(result.valid).toBe(true);
      expect(result.normalized).toBeDefined();
      expect(result.normalized?.action).toBe('hold');
    });

    it('rejects an invalid decision payload', async () => {
      const result = await service.validateDecision({
        action: 'invalid_action',
        sizeUsd: -5,
      });
      expect(result.valid).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errors!.length).toBeGreaterThan(0);
    });

    it('rejects a missing required field', async () => {
      const result = await service.validateDecision({
        action: 'buy_up',
        // missing sizeUsd, confidence, reasoning, etc.
      });
      expect(result.valid).toBe(false);
    });
  });

  // ─── logDecision ──────────────────────────────────────────────────────────

  describe('logDecision', () => {
    it('logs a decision and returns an id', async () => {
      const result = await service.logDecision({
        windowId: 'win-log-1',
        agentType: 'supervisor',
        output: { action: 'hold', sizeUsd: 0, confidence: 0.5, reasoning: 'Test.' },
        input: { test: true },
      });
      expect(result.id).toMatch(/^trace-/);
      expect(result.logged).toBe(true);
    });

    it('logged decision appears in traces', async () => {
      await service.logDecision({
        windowId: 'win-log-2',
        agentType: 'regime',
        output: { regime: 'quiet', confidence: 0.3, reasoning: 'Low activity.' },
      });

      const traces = await service.listTraces('regime', 'win-log-2');
      expect(traces.length).toBe(1);
      expect(traces[0]?.windowId).toBe('win-log-2');
    });

    it('logged decision is retrievable by ID', async () => {
      const result = await service.logDecision({
        windowId: 'win-log-3',
        agentType: 'edge',
        output: { direction: 'none', magnitude: 0, confidence: 0.2, reasoning: 'No edge.' },
      });

      const trace = await service.getTrace(result.id);
      expect(trace.id).toBe(result.id);
      expect(trace.agentType).toBe('edge');
    });
  });

  // ─── onModuleInit / env config ─────────────────────────────────────────────

  describe('onModuleInit', () => {
    it('reads configuration from environment variables', async () => {
      const db = createDb(':memory:');
      const mockClient = createMockLlmClient();
      const mockLogger = createMockLogger();
      const envService = new AgentGatewayService(db, new EventBus(), mockClient as any, mockLogger);

      process.env.AGENT_PROVIDER = 'openai';
      process.env.AGENT_MODEL = 'gpt-4o';
      process.env.AGENT_TEMPERATURE = '0.5';

      await envService.onModuleInit();

      const trace = await envService.evaluateRegime({
        windowId: 'win-050',
        features: makeFeaturePayload(),
      });

      expect(trace.provider).toBe('openai');
      expect(trace.model).toBe('gpt-4o');

      delete process.env.AGENT_PROVIDER;
      delete process.env.AGENT_MODEL;
      delete process.env.AGENT_TEMPERATURE;
    });

    it('uses default values when env is not set', async () => {
      delete process.env.AGENT_PROVIDER;
      delete process.env.AGENT_MODEL;

      const db = createDb(':memory:');
      const mockClient = createMockLlmClient();
      const mockLogger = createMockLogger();
      const defaultService = new AgentGatewayService(db, new EventBus(), mockClient as any, mockLogger);
      await defaultService.onModuleInit();

      const trace = await defaultService.evaluateRegime({
        windowId: 'win-051',
        features: makeFeaturePayload(),
      });

      expect(trace.provider).toBe('openai');
      expect(trace.model).toBe('gpt-4o');
    });
  });

  // ─── Output shape validation (Zod) ────────────────────────────────────────

  describe('output shape validation', () => {
    it('regime output passes Zod schema validation', async () => {
      const trace = await service.evaluateRegime({
        windowId: 'win-060',
        features: makeFeaturePayload(),
      });

      const output = trace.parsedOutput as RegimeOutput;
      // The service already validates via Zod internally; verify the shape
      expect(typeof output.regime).toBe('string');
      expect(typeof output.confidence).toBe('number');
      expect(typeof output.reasoning).toBe('string');
    });

    it('edge output passes Zod schema validation', async () => {
      const trace = await service.evaluateEdge({
        windowId: 'win-061',
        features: makeFeaturePayload(),
      });

      const output = trace.parsedOutput as EdgeOutput;
      expect(typeof output.direction).toBe('string');
      expect(typeof output.magnitude).toBe('number');
      expect(typeof output.confidence).toBe('number');
      expect(typeof output.reasoning).toBe('string');
    });

    it('rawResponse is valid JSON matching parsedOutput', async () => {
      const trace = await service.evaluateRegime({
        windowId: 'win-062',
        features: makeFeaturePayload(),
      });

      const fromRaw = JSON.parse(trace.rawResponse);
      expect(fromRaw).toEqual(trace.parsedOutput);
    });
  });

  // ─── createdAt format ──────────────────────────────────────────────────────

  describe('trace metadata', () => {
    it('createdAt is a valid ISO-8601 timestamp', async () => {
      const trace = await service.evaluateRegime({
        windowId: 'win-070',
        features: makeFeaturePayload(),
      });

      const date = new Date(trace.createdAt);
      expect(date.toISOString()).toBe(trace.createdAt);
    });

    it('trace id is unique across calls', async () => {
      const t1 = await service.evaluateRegime({
        windowId: 'win-071a',
        features: makeFeaturePayload({ eventTime: 1700000000000 }),
      });
      const t2 = await service.evaluateRegime({
        windowId: 'win-071b',
        features: makeFeaturePayload({ eventTime: 1700000001000 }),
      });

      expect(t1.id).not.toBe(t2.id);
    });
  });

  // ─── Agent Profile Selection ──────────────────────────────────────────────

  describe('agent profile selection', () => {
    it('uses default regime prompt when no profile is specified', async () => {
      const trace = await service.evaluateRegime({
        windowId: 'win-profile-004',
        features: makeFeaturePayload({ eventTime: 1700000004000 }),
      });

      expect(trace.systemPrompt).toContain('market regime classification agent for a Polymarket');
    });

    it('falls back to default prompt for unknown profile', async () => {
      const trace = await service.evaluateRegime({
        windowId: 'win-profile-005',
        features: makeFeaturePayload({ eventTime: 1700000005000 }),
        agentProfile: 'regime-nonexistent-v99',
      });

      expect(trace.systemPrompt).toContain('market regime classification agent for a Polymarket');
    });
  });
});
