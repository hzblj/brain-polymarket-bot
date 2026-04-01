import { agentDecisions, DATABASE_CLIENT, type DbClient } from '@brain/database';
import { type BrainEventName, type BrainEventMap, EventBus } from '@brain/events';
import { type LlmClient, type ReasoningEffort, OpenAIClient } from '@brain/llm-clients';
import { BrainLoggerService } from '@brain/logger';
import { EdgeOutputSchema, GatekeeperOutputSchema, RegimeOutputSchema, SupervisorOutputSchema, ValidatorOutputSchema } from '@brain/schemas';
import type {
  AgentType,
  EdgeOutput,
  FeaturePayload,
  GatekeeperOutput,
  RegimeOutput,
  RiskConfig,
  RiskState,
  SupervisorOutput,
  ValidatorOutput,
  UnixMs,
} from '@brain/types';
import { HttpException, HttpStatus, Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import type { z } from 'zod';
import {
  REGIME_SYSTEM_PROMPT,
  EDGE_SYSTEM_PROMPT,
  SUPERVISOR_SYSTEM_PROMPT,
  VALIDATOR_SYSTEM_PROMPT,
  GATEKEEPER_SYSTEM_PROMPT,
} from './prompts';

// ─── Prompt Registry ────────────────────────────────────────────────────────

export const REGIME_PROMPT_REGISTRY: Record<string, string> = {
  'regime-default-v1': REGIME_SYSTEM_PROMPT,
};

export const EDGE_PROMPT_REGISTRY: Record<string, string> = {
  'edge-momentum-v1': EDGE_SYSTEM_PROMPT,
};

export const SUPERVISOR_PROMPT_REGISTRY: Record<string, string> = {
  'supervisor-momentum-v1': SUPERVISOR_SYSTEM_PROMPT,
};

export function resolvePrompt(
  registry: Record<string, string>,
  profile: string | undefined,
  fallback: string,
): string {
  if (!profile) return fallback;
  return registry[profile] ?? fallback;
}

// ─── Request / Response Types ────────────────────────────────────────────────

export interface RegimeEvaluationRequest {
  windowId: string;
  features: FeaturePayload;
  agentProfile?: string;
}

export interface EdgeEvaluationRequest {
  windowId: string;
  features: FeaturePayload;
  agentProfile?: string;
}

export interface SupervisorEvaluationRequest {
  windowId: string;
  features: FeaturePayload;
  regime: RegimeOutput;
  edge: EdgeOutput;
  riskState: RiskState;
  riskConfig: RiskConfig;
  agentProfile?: string;
}

export interface ValidatorEvaluationRequest {
  windowId: string;
  features: FeaturePayload;
}

export interface GatekeeperEvaluationRequest {
  windowId: string;
  freshFeatures: FeaturePayload;
  preComputedDecision: SupervisorOutput;
  preComputeFeaturesSummary: {
    returnBps: number;
    spreadBps: number;
    depthScore: number;
    currentPrice: number;
    volatility: number;
  };
  timeElapsedSec: number;
}

export interface AgentTrace {
  id: string;
  windowId: string;
  agentType: AgentType;
  model: string;
  provider: string;
  systemPrompt: string;
  userPrompt: string;
  rawResponse: string;
  parsedOutput: RegimeOutput | EdgeOutput | SupervisorOutput | ValidatorOutput | GatekeeperOutput;
  latencyMs: number;
  tokenUsage: { input: number; output: number };
  cached: boolean;
  createdAt: string;
}

// ─── Cache Entry ─────────────────────────────────────────────────────────────

interface CacheEntry {
  key: string;
  result: RegimeOutput | EdgeOutput | SupervisorOutput | ValidatorOutput | GatekeeperOutput;
  createdAt: number;
}

const CACHE_TTL_MS = 5_000; // 5 second cache for identical requests within same window

@Injectable()
export class AgentGatewayService implements OnModuleInit {
  private traces: Map<string, AgentTrace> = new Map();
  private cache: Map<string, CacheEntry> = new Map();
  private readonly llmClient: LlmClient;
  private readonly logger: BrainLoggerService;

  // Default config — will be overridden by env / config-service
  private provider: 'anthropic' | 'openai' = 'openai';
  private model = 'gpt-5.4';
  private supervisorModel: string | undefined;
  private validatorModel = 'gpt-5.4-nano';
  private gatekeeperModel = 'gpt-5.4-mini';
  private temperature = 0;
  private timeoutMs = 30_000;
  private validatorTimeoutMs = 2_000;
  private gatekeeperTimeoutMs = 5_000;
  private maxRetries = 2;

  constructor(
    @Inject(DATABASE_CLIENT) private readonly db: DbClient,
    @Inject(EventBus) private readonly eventBus: EventBus,
    @Inject(OpenAIClient) openaiClient: OpenAIClient,
    @Inject(BrainLoggerService) logger: BrainLoggerService,
  ) {
    this.llmClient = openaiClient;
    this.logger = logger.child('AgentGatewayService');
  }

  onModuleInit(): void {
    // Load config from env
    this.provider = (process.env.AGENT_PROVIDER as 'anthropic' | 'openai') ?? this.provider;
    this.model = process.env.AGENT_MODEL ?? this.model;
    this.supervisorModel = process.env.SUPERVISOR_MODEL;
    this.validatorModel = process.env.VALIDATOR_MODEL ?? this.validatorModel;
    this.gatekeeperModel = process.env.GATEKEEPER_MODEL ?? this.gatekeeperModel;
    this.validatorTimeoutMs = process.env.VALIDATOR_TIMEOUT_MS
      ? parseInt(process.env.VALIDATOR_TIMEOUT_MS, 10)
      : this.validatorTimeoutMs;
    this.gatekeeperTimeoutMs = process.env.GATEKEEPER_TIMEOUT_MS
      ? parseInt(process.env.GATEKEEPER_TIMEOUT_MS, 10)
      : this.gatekeeperTimeoutMs;
    this.temperature = process.env.AGENT_TEMPERATURE
      ? parseFloat(process.env.AGENT_TEMPERATURE)
      : this.temperature;
    this.timeoutMs = process.env.AGENT_TIMEOUT_MS
      ? parseInt(process.env.AGENT_TIMEOUT_MS, 10)
      : this.timeoutMs;
    this.maxRetries = process.env.AGENT_MAX_RETRIES
      ? parseInt(process.env.AGENT_MAX_RETRIES, 10)
      : this.maxRetries;
  }

  // ─── Public API ──────────────────────────────────────────────────────────────

  /**
   * Evaluates market regime using the regime agent.
   */
  async evaluateRegime(request: RegimeEvaluationRequest): Promise<AgentTrace> {
    const { windowId, features, agentProfile } = request;

    // Check cache
    const cacheKey = this.buildCacheKey('regime', windowId, features.eventTime);
    const cached = this.getFromCache(cacheKey);
    if (cached) {
      const trace = this.findTraceByCache(cacheKey);
      if (trace) return { ...trace, cached: true };
    }

    const systemPrompt = resolvePrompt(REGIME_PROMPT_REGISTRY, agentProfile, REGIME_SYSTEM_PROMPT);
    const userPrompt = this.buildRegimeUserPrompt(features);
    const result = await this.callAgent<RegimeOutput>(
      'regime',
      windowId,
      systemPrompt,
      userPrompt,
      RegimeOutputSchema,
    );

    this.setCache(cacheKey, result.parsedOutput);
    return result;
  }

  /**
   * Evaluates edge using the edge agent.
   */
  async evaluateEdge(request: EdgeEvaluationRequest): Promise<AgentTrace> {
    const { windowId, features, agentProfile } = request;

    const cacheKey = this.buildCacheKey('edge', windowId, features.eventTime);
    const cached = this.getFromCache(cacheKey);
    if (cached) {
      const trace = this.findTraceByCache(cacheKey);
      if (trace) return { ...trace, cached: true };
    }

    const systemPrompt = resolvePrompt(EDGE_PROMPT_REGISTRY, agentProfile, EDGE_SYSTEM_PROMPT);
    const userPrompt = this.buildEdgeUserPrompt(features);
    const result = await this.callAgent<EdgeOutput>(
      'edge',
      windowId,
      systemPrompt,
      userPrompt,
      EdgeOutputSchema,
    );

    this.setCache(cacheKey, result.parsedOutput);
    return result;
  }

  /**
   * Evaluates trade decision using the supervisor agent.
   */
  async evaluateSupervisor(request: SupervisorEvaluationRequest): Promise<AgentTrace> {
    const { windowId, features, regime, edge, riskState, riskConfig, agentProfile } = request;

    const cacheKey = this.buildCacheKey('supervisor', windowId, features.eventTime);
    const cached = this.getFromCache(cacheKey);
    if (cached) {
      const trace = this.findTraceByCache(cacheKey);
      if (trace) return { ...trace, cached: true };
    }

    const systemPrompt = resolvePrompt(SUPERVISOR_PROMPT_REGISTRY, agentProfile, SUPERVISOR_SYSTEM_PROMPT);
    const userPrompt = this.buildSupervisorUserPrompt(
      features,
      regime,
      edge,
      riskState,
      riskConfig,
    );
    const result = await this.callAgent<SupervisorOutput>(
      'supervisor',
      windowId,
      systemPrompt,
      userPrompt,
      SupervisorOutputSchema,
    );

    this.setCache(cacheKey, result.parsedOutput);
    return result;
  }

  /**
   * Ultra-fast input validation using GPT-5.4 nano.
   * Checks feature data sanity before gatekeeper evaluation.
   */
  async evaluateValidator(request: ValidatorEvaluationRequest): Promise<AgentTrace> {
    const { windowId, features } = request;

    const userPrompt = JSON.stringify(
      {
        windowId: features.windowId,
        eventTime: features.eventTime,
        remainingMs: features.market?.remainingMs,
        price: {
          currentPrice: features.price?.currentPrice,
          returnBps: features.price?.returnBps,
          volatility: features.price?.volatility,
        },
        book: {
          spreadBps: features.book?.spreadBps,
          depthScore: features.book?.depthScore,
        },
        signals: features.signals ? { tradeable: features.signals.tradeable } : null,
        hasWhales: !!features.whales,
        hasDerivatives: !!features.derivatives,
        ...(features.whales ? { whaleFlowPressure: features.whales.exchangeFlowPressure } : {}),
        ...(features.derivatives ? { fundingPressure: features.derivatives.fundingPressure } : {}),
      },
      null,
      2,
    );

    return this.callAgent<ValidatorOutput>(
      'validator',
      windowId,
      VALIDATOR_SYSTEM_PROMPT,
      userPrompt,
      ValidatorOutputSchema,
      this.validatorModel,
    );
  }

  /**
   * Fast gatekeeper validation using GPT-5.4 mini.
   * Compares pre-computed supervisor decision against fresh market data.
   */
  async evaluateGatekeeper(request: GatekeeperEvaluationRequest): Promise<AgentTrace> {
    const { windowId, freshFeatures, preComputedDecision, preComputeFeaturesSummary, timeElapsedSec } = request;

    const userPrompt = JSON.stringify(
      {
        preComputedDecision: {
          action: preComputedDecision.action,
          sizeUsd: preComputedDecision.sizeUsd,
          confidence: preComputedDecision.confidence,
          reasoning: preComputedDecision.reasoning,
        },
        freshData: {
          returnBps: freshFeatures.price?.returnBps,
          spreadBps: freshFeatures.book?.spreadBps,
          depthScore: freshFeatures.book?.depthScore,
          currentPrice: freshFeatures.price?.currentPrice,
          volatility: freshFeatures.price?.volatility,
          remainingMs: freshFeatures.market?.remainingMs,
          momentum: freshFeatures.price?.momentum,
        },
        preComputeSnapshot: preComputeFeaturesSummary,
        deltas: {
          returnBpsChange: (freshFeatures.price?.returnBps ?? 0) - preComputeFeaturesSummary.returnBps,
          spreadBpsChange: (freshFeatures.book?.spreadBps ?? 0) - preComputeFeaturesSummary.spreadBps,
          depthScoreChange: (freshFeatures.book?.depthScore ?? 0) - preComputeFeaturesSummary.depthScore,
          priceChange: (freshFeatures.price?.currentPrice ?? 0) - preComputeFeaturesSummary.currentPrice,
        },
        timeElapsedSec,
      },
      null,
      2,
    );

    return this.callAgent<GatekeeperOutput>(
      'gatekeeper',
      windowId,
      GATEKEEPER_SYSTEM_PROMPT,
      userPrompt,
      GatekeeperOutputSchema,
      this.gatekeeperModel,
    );
  }

  /**
   * Returns a combined structured context for agents.
   * Aggregates recent traces, current config state, and cache status.
   */
  async getContext(): Promise<Record<string, unknown>> {
    const recentTraces = await this.listTraces(undefined, undefined, 10);
    return {
      provider: this.provider,
      model: this.model,
      temperature: this.temperature,
      timeoutMs: this.timeoutMs,
      maxRetries: this.maxRetries,
      cacheSize: this.cache.size,
      tracesInMemory: this.traces.size,
      recentTraces: recentTraces.map((t) => ({
        id: t.id,
        windowId: t.windowId,
        agentType: t.agentType,
        latencyMs: t.latencyMs,
        cached: t.cached,
        createdAt: t.createdAt,
      })),
    };
  }

  /**
   * Validates an agent decision payload against the supervisor output schema.
   */
  async validateDecision(payload: Record<string, unknown>): Promise<{ valid: boolean; errors?: Array<{ path: string; message: string }>; normalized?: SupervisorOutput }> {
    const parsed = SupervisorOutputSchema.safeParse(payload);
    if (!parsed.success) {
      return {
        valid: false,
        errors: parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      };
    }
    return { valid: true, normalized: parsed.data };
  }

  /**
   * Logs an externally-produced decision trace.
   */
  async logDecision(payload: Record<string, unknown>): Promise<{ id: string; logged: boolean }> {
    const id = `trace-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const windowId = (payload.windowId as string) ?? 'unknown';
    const agentType = (payload.agentType as AgentType) ?? 'supervisor';
    const output = payload.output ?? payload;

    const trace: AgentTrace = {
      id,
      windowId,
      agentType,
      model: (payload.model as string) ?? this.model,
      provider: (payload.provider as string) ?? this.provider,
      systemPrompt: '',
      userPrompt: JSON.stringify(payload.input ?? {}),
      rawResponse: JSON.stringify(output),
      parsedOutput: output as RegimeOutput | EdgeOutput | SupervisorOutput | ValidatorOutput | GatekeeperOutput,
      latencyMs: (payload.latencyMs as number) ?? 0,
      tokenUsage: { input: 0, output: 0 },
      cached: false,
      createdAt: new Date().toISOString(),
    };

    this.traces.set(id, trace);

    try {
      await this.db.insert(agentDecisions).values({
        id,
        windowId,
        agentType,
        input: (payload.input as Record<string, unknown>) ?? {},
        output: output as Record<string, unknown>,
        model: trace.model,
        provider: trace.provider,
        latencyMs: trace.latencyMs,
        eventTime: Date.now(),
        processedAt: Date.now(),
      });
    } catch (_dbError) {
      /* best-effort persistence */
    }

    return { id, logged: true };
  }

  /**
   * Lists recent agent traces, optionally filtered.
   */
  async listTraces(agentType?: string, windowId?: string, limit = 50): Promise<AgentTrace[]> {
    // In-memory traces first
    let traces = Array.from(this.traces.values());

    if (agentType) {
      traces = traces.filter((t) => t.agentType === agentType);
    }
    if (windowId) {
      traces = traces.filter((t) => t.windowId === windowId);
    }

    // Fall back to database if in-memory is empty
    if (traces.length === 0) {
      const conditions: ReturnType<typeof eq>[] = [];
      if (agentType)
        conditions.push(
          eq(agentDecisions.agentType, agentType as 'regime' | 'edge' | 'supervisor'),
        );
      if (windowId) conditions.push(eq(agentDecisions.windowId, windowId));

      const rows = await this.db
        .select()
        .from(agentDecisions)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(agentDecisions.processedAt))
        .limit(limit);

      return rows.map((r) => ({
        id: r.id,
        windowId: r.windowId,
        agentType: r.agentType as AgentType,
        model: r.model,
        provider: r.provider,
        systemPrompt: '',
        userPrompt: JSON.stringify(r.input),
        rawResponse: JSON.stringify(r.output),
        parsedOutput: r.output as RegimeOutput | EdgeOutput | SupervisorOutput | ValidatorOutput | GatekeeperOutput,
        latencyMs: r.latencyMs,
        tokenUsage: { input: 0, output: 0 },
        cached: false,
        createdAt: new Date(r.processedAt).toISOString(),
      }));
    }

    return traces
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, limit);
  }

  /**
   * Returns a single trace by ID.
   */
  async getTrace(traceId: string): Promise<AgentTrace> {
    const trace = this.traces.get(traceId);
    if (trace) return trace;

    // Fall back to database
    const [r] = await this.db
      .select()
      .from(agentDecisions)
      .where(eq(agentDecisions.id, traceId))
      .limit(1);
    if (r) {
      return {
        id: r.id,
        windowId: r.windowId,
        agentType: r.agentType as AgentType,
        model: r.model,
        provider: r.provider,
        systemPrompt: '',
        userPrompt: JSON.stringify(r.input),
        rawResponse: JSON.stringify(r.output),
        parsedOutput: r.output as RegimeOutput | EdgeOutput | SupervisorOutput | ValidatorOutput | GatekeeperOutput,
        latencyMs: r.latencyMs,
        tokenUsage: { input: 0, output: 0 },
        cached: false,
        createdAt: new Date(r.processedAt).toISOString(),
      };
    }

    throw new HttpException(`Trace ${traceId} not found`, HttpStatus.NOT_FOUND);
  }

  // ─── Core Agent Call ───────────────────────────────────────────────────────

  // Default reasoning effort per agent type
  private static readonly REASONING_EFFORT: Record<AgentType, ReasoningEffort> = {
    regime: 'medium',
    edge: 'medium',
    supervisor: 'high',
    validator: 'low',
    gatekeeper: 'low',
  };

  private async callAgent<T extends RegimeOutput | EdgeOutput | SupervisorOutput | ValidatorOutput | GatekeeperOutput>(
    agentType: AgentType,
    windowId: string,
    systemPrompt: string,
    userPrompt: string,
    schema: z.ZodSchema<T>,
    modelOverrideParam?: string,
    reasoningEffortOverride?: ReasoningEffort,
  ): Promise<AgentTrace> {
    const startMs = Date.now();

    try {
      this.logger.debug('Calling agent', { agentType, windowId });

      // Use explicit model override, or supervisor-specific model, or default
      const modelOverride = modelOverrideParam ?? (agentType === 'supervisor' ? this.supervisorModel : undefined);
      const reasoningEffort = reasoningEffortOverride ?? AgentGatewayService.REASONING_EFFORT[agentType];
      const response = await this.llmClient.evaluate(systemPrompt, userPrompt, schema, {
        ...(modelOverride ? { model: modelOverride } : {}),
        reasoningEffort,
      });
      const parsedOutput = response.data as T;
      const rawResponse = JSON.stringify(parsedOutput);
      const latencyMs = Date.now() - startMs;
      const tokenUsage = { input: response.inputTokens, output: response.outputTokens };

      const trace: AgentTrace = {
        id: `trace-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        windowId,
        agentType,
        model: response.model,
        provider: response.provider,
        systemPrompt,
        userPrompt,
        rawResponse,
        parsedOutput,
        latencyMs,
        tokenUsage,
        cached: false,
        createdAt: new Date().toISOString(),
      };

      // Store trace
      this.traces.set(trace.id, trace);

      // Persist to database (agent_decisions table)
      try {
        await this.db.insert(agentDecisions).values({
          id: trace.id,
          windowId,
          agentType,
          input: JSON.parse(userPrompt),
          output: parsedOutput as unknown as Record<string, unknown>,
          model: response.model,
          provider: response.provider,
          latencyMs,
          eventTime: Date.now(),
          processedAt: Date.now(),
        });
      } catch (_dbError) {
        /* best-effort persistence */
      }

      this.logger.info('Agent evaluation complete', {
        agentType,
        windowId,
        latencyMs,
        inputTokens: tokenUsage.input,
        outputTokens: tokenUsage.output,
      });

      return trace;
    } catch (error) {
      const latencyMs = Date.now() - startMs;
      this.logger.error('Agent evaluation failed', (error as Error).message, {
        agentType,
        windowId,
        latencyMs,
      });

      throw new HttpException(
        `Agent ${agentType} failed: ${(error as Error).message}`,
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }

  // ─── Prompt Builders ───────────────────────────────────────────────────────

  private buildRegimeUserPrompt(features: FeaturePayload): string {
    return JSON.stringify(
      {
        windowId: features.windowId,
        eventTime: features.eventTime,
        remainingMs: features.market.remainingMs,
        elapsedMs: features.market.elapsedMs,
        price: {
          currentPrice: features.price.currentPrice,
          returnBps: features.price.returnBps,
          volatility: features.price.volatility,
          momentum: features.price.momentum,
          meanReversionStrength: features.price.meanReversionStrength,
          tickRate: features.price.tickRate,
        },
        book: {
          spreadBps: features.book.spreadBps,
          depthScore: features.book.depthScore,
          imbalance: features.book.imbalance,
          bidDepthUsd: features.book.bidDepthUsd ?? 0,
          askDepthUsd: features.book.askDepthUsd ?? 0,
        },
        signals: features.signals,
        ...(features.whales ? {
          whales: {
            exchangeFlowPressure: features.whales.exchangeFlowPressure,
            abnormalActivityScore: features.whales.abnormalActivityScore,
            largeTransactionCount: features.whales.largeTransactionCount,
            whaleVolumeBtc: features.whales.whaleVolumeBtc,
          },
        } : {}),
        ...(features.derivatives ? {
          derivatives: {
            fundingPressure: features.derivatives.fundingPressure,
            oiTrend: features.derivatives.oiTrend,
            liquidationIntensity: features.derivatives.liquidationIntensity,
            liquidationImbalance: features.derivatives.liquidationImbalance,
            derivativesSentiment: features.derivatives.derivativesSentiment,
          },
        } : {}),
        ...this.buildBlockchainPromptData(features),
      },
      null,
      2,
    );
  }

  private buildEdgeUserPrompt(features: FeaturePayload): string {
    return JSON.stringify(
      {
        windowId: features.windowId,
        eventTime: features.eventTime,
        remainingMs: features.market.remainingMs,
        startPrice: features.market.startPrice,
        price: {
          currentPrice: features.price.currentPrice,
          returnBps: features.price.returnBps,
          volatility: features.price.volatility,
          momentum: features.price.momentum,
          binancePrice: features.price.binancePrice,
          coinbasePrice: features.price.coinbasePrice,
          exchangeMidPrice: features.price.exchangeMidPrice,
          polymarketMidPrice: features.price.polymarketMidPrice,
          basisBps: features.price.basisBps,
        },
        book: {
          upBid: features.book.upBid,
          upAsk: features.book.upAsk,
          downBid: features.book.downBid,
          downAsk: features.book.downAsk,
          spreadBps: features.book.spreadBps,
          depthScore: features.book.depthScore,
          imbalance: features.book.imbalance,
          bidDepthUsd: features.book.bidDepthUsd ?? 0,
          askDepthUsd: features.book.askDepthUsd ?? 0,
        },
        signals: features.signals,
        ...(features.whales ? {
          whales: {
            netExchangeFlowBtc: features.whales.netExchangeFlowBtc,
            exchangeFlowPressure: features.whales.exchangeFlowPressure,
            abnormalActivityScore: features.whales.abnormalActivityScore,
            whaleVolumeBtc: features.whales.whaleVolumeBtc,
          },
        } : {}),
        ...(features.derivatives ? {
          derivatives: {
            fundingRate: features.derivatives.fundingRate,
            fundingRateAnnualized: features.derivatives.fundingRateAnnualized,
            fundingPressure: features.derivatives.fundingPressure,
            openInterestUsd: features.derivatives.openInterestUsd,
            openInterestChangePct: features.derivatives.openInterestChangePct,
            oiTrend: features.derivatives.oiTrend,
            longLiquidationUsd: features.derivatives.longLiquidationUsd,
            shortLiquidationUsd: features.derivatives.shortLiquidationUsd,
            liquidationImbalance: features.derivatives.liquidationImbalance,
            liquidationIntensity: features.derivatives.liquidationIntensity,
            derivativesSentiment: features.derivatives.derivativesSentiment,
          },
        } : {}),
        ...this.buildBlockchainPromptData(features),
      },
      null,
      2,
    );
  }

  private buildSupervisorUserPrompt(
    features: FeaturePayload,
    regime: RegimeOutput,
    edge: EdgeOutput,
    riskState: RiskState,
    riskConfig: RiskConfig,
  ): string {
    return JSON.stringify(
      {
        windowId: features.windowId,
        eventTime: features.eventTime,
        remainingMs: features.market.remainingMs,
        features: {
          price: {
            currentPrice: features.price.currentPrice,
            returnBps: features.price.returnBps,
            volatility: features.price.volatility,
            momentum: features.price.momentum,
            basisBps: features.price.basisBps,
          },
          book: {
            upBid: features.book.upBid,
            upAsk: features.book.upAsk,
            spreadBps: features.book.spreadBps,
            depthScore: features.book.depthScore,
            imbalance: features.book.imbalance,
            bidDepthUsd: features.book.bidDepthUsd ?? 0,
            askDepthUsd: features.book.askDepthUsd ?? 0,
          },
          signals: features.signals,
        },
        ...(features.whales ? {
          whales: {
            netExchangeFlowBtc: features.whales.netExchangeFlowBtc,
            exchangeFlowPressure: features.whales.exchangeFlowPressure,
            abnormalActivityScore: features.whales.abnormalActivityScore,
          },
        } : {}),
        ...(features.derivatives ? {
          derivatives: {
            fundingPressure: features.derivatives.fundingPressure,
            liquidationIntensity: features.derivatives.liquidationIntensity,
            liquidationImbalance: features.derivatives.liquidationImbalance,
            derivativesSentiment: features.derivatives.derivativesSentiment,
          },
        } : {}),
        ...this.buildBlockchainPromptData(features),
        regime: {
          regime: regime.regime,
          confidence: regime.confidence,
          reasoning: regime.reasoning,
        },
        edge: {
          direction: edge.direction,
          magnitude: edge.magnitude,
          confidence: edge.confidence,
          reasoning: edge.reasoning,
        },
        risk: {
          dailyPnlUsd: riskState.dailyPnlUsd,
          openPositionUsd: riskState.openPositionUsd,
          tradesInWindow: riskState.tradesInWindow,
          maxSizeUsd: riskConfig.maxSizeUsd,
          dailyLossLimitUsd: riskConfig.dailyLossLimitUsd,
        },
      },
      null,
      2,
    );
  }

  private buildBlockchainPromptData(features: FeaturePayload): Record<string, unknown> {
    if (!features.blockchain) return {};
    const bc = features.blockchain;
    return {
      blockchain: {
        mempool: {
          pendingTxCount: bc.mempool.txCount,
          totalFeeBtc: bc.mempool.totalFeeBtc,
          vsizeMb: Math.round(bc.mempool.vsize / 1_000_000 * 10) / 10,
        },
        fees: {
          fastestSatVb: bc.fees.fastest,
          hourSatVb: bc.fees.hour,
        },
        notableTransactions1h: {
          total: bc.notableTransactions.total,
          totalBtc: bc.notableTransactions.totalBtc,
          exchangeInflowsBtc: bc.notableTransactions.exchangeInflows.btc,
          exchangeOutflowsBtc: bc.notableTransactions.exchangeOutflows.btc,
          netExchangeFlowBtc: Math.round((bc.notableTransactions.exchangeInflows.btc - bc.notableTransactions.exchangeOutflows.btc) * 10000) / 10000,
        },
        trend: bc.trend,
        ...(bc.latestBlock ? {
          latestBlock: {
            height: bc.latestBlock.height,
            txCount: bc.latestBlock.txCount,
          },
        } : {}),
      },
    };
  }

  // ─── Cache Helpers ─────────────────────────────────────────────────────────

  private buildCacheKey(agentType: string, windowId: string, eventTime: UnixMs): string {
    // Round eventTime to nearest second to allow some cache hits
    const roundedTime = Math.floor(eventTime / 1000) * 1000;
    return `${agentType}:${windowId}:${roundedTime}`;
  }

  private getFromCache(key: string): CacheEntry | null {
    const entry = this.cache.get(key);
    if (!entry) return null;

    if (Date.now() - entry.createdAt > CACHE_TTL_MS) {
      this.cache.delete(key);
      return null;
    }

    return entry;
  }

  private setCache(key: string, result: RegimeOutput | EdgeOutput | SupervisorOutput | ValidatorOutput | GatekeeperOutput): void {
    this.cache.set(key, { key, result, createdAt: Date.now() });

    // Evict old entries periodically
    if (this.cache.size > 100) {
      const now = Date.now();
      for (const [k, v] of this.cache.entries()) {
        if (now - v.createdAt > CACHE_TTL_MS) {
          this.cache.delete(k);
        }
      }
    }
  }

  private findTraceByCache(cacheKey: string): AgentTrace | null {
    // Find the most recent trace matching this cache key
    for (const trace of this.traces.values()) {
      const traceKey = this.buildCacheKey(
        trace.agentType,
        trace.windowId,
        JSON.parse(trace.userPrompt).eventTime ?? 0,
      );
      if (traceKey === cacheKey) return trace;
    }
    return null;
  }

  // ─── Utilities ─────────────────────────────────────────────────────────────

  private emitEvent<E extends BrainEventName>(event: E, payload: BrainEventMap[E]): void {
    this.eventBus.emit(event, payload);
  }
}
