import { agentDecisions, featureSnapshots, orders, promptPatches, DATABASE_CLIENT, type DbClient } from '@brain/database';
import { type BrainEventName, type BrainEventMap, EventBus } from '@brain/events';
import { type LlmClient, type ReasoningEffort, OpenAIClient } from '@brain/llm-clients';
import { BrainLoggerService } from '@brain/logger';
import { EdgeOutputSchema, EvalOutputSchema, GatekeeperOutputSchema, RegimeOutputSchema, SupervisorOutputSchema } from '@brain/schemas';
import type {
  AgentType,
  EdgeOutput,
  EvalOutput,
  FeaturePayload,
  GatekeeperOutput,
  PatchableAgent,
  RegimeOutput,
  RiskConfig,
  RiskState,
  SupervisorOutput,
  UnixMs,
} from '@brain/types';
import { HttpException, HttpStatus, Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { and, desc, eq, gte, sql, sum } from 'drizzle-orm';
import type { z } from 'zod';
import {
  REGIME_SYSTEM_PROMPT,
  EDGE_SYSTEM_PROMPT,
  SUPERVISOR_SYSTEM_PROMPT,
  EDGE_MEAN_REVERSION_PROMPT,
  EDGE_SWEEP_PROMPT,
  EDGE_AMD_PROMPT,
  EDGE_VOL_FADE_PROMPT,
  SUPERVISOR_MEAN_REVERSION_PROMPT,
  SUPERVISOR_AMD_PROMPT,
  SUPERVISOR_VOL_FADE_PROMPT,
  GATEKEEPER_SYSTEM_PROMPT,
  EVAL_SYSTEM_PROMPT,
} from './prompts';

// ─── Prompt Registry ────────────────────────────────────────────────────────

export const REGIME_PROMPT_REGISTRY: Record<string, string> = {
  'regime-default-v1': REGIME_SYSTEM_PROMPT,
};

export const EDGE_PROMPT_REGISTRY: Record<string, string> = {
  'edge-momentum-v1': EDGE_SYSTEM_PROMPT,
  'edge-mean-reversion-v1': EDGE_MEAN_REVERSION_PROMPT,
  'edge-sweep-v1': EDGE_SWEEP_PROMPT,
  'edge-amd-v1': EDGE_AMD_PROMPT,
  'edge-vol-fade-v1': EDGE_VOL_FADE_PROMPT,
};

export const SUPERVISOR_PROMPT_REGISTRY: Record<string, string> = {
  'supervisor-momentum-v1': SUPERVISOR_SYSTEM_PROMPT,
  'supervisor-mean-reversion-v1': SUPERVISOR_MEAN_REVERSION_PROMPT,
  'supervisor-amd-v1': SUPERVISOR_AMD_PROMPT,
  'supervisor-vol-fade-v1': SUPERVISOR_VOL_FADE_PROMPT,
};

export function resolvePrompt(
  registry: Record<string, string>,
  profile: string | undefined,
  fallback: string,
): string {
  if (!profile) return fallback;
  return registry[profile] ?? fallback;
}

// ─── LLM Cost Calculator ────────────────────────────────────────────────────

/** Per-token pricing in USD (input / output per 1M tokens) */
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  // OpenAI
  'gpt-5.4':        { input: 2.00, output: 8.00 },
  'gpt-5.4-mini':   { input: 0.30, output: 1.20 },
  'gpt-5.4-nano':   { input: 0.10, output: 0.40 },
  'gpt-4o':         { input: 2.50, output: 10.00 },
  'gpt-4o-mini':    { input: 0.15, output: 0.60 },
  // Anthropic
  'claude-sonnet-4-20250514':  { input: 3.00, output: 15.00 },
  'claude-opus-4-20250514':    { input: 15.00, output: 75.00 },
  'claude-haiku-3-20240307':   { input: 0.25, output: 1.25 },
};

/** Default fallback pricing if model is not in the map */
const DEFAULT_PRICING = { input: 2.00, output: 8.00 };

export function calculateLlmCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = MODEL_PRICING[model] ?? DEFAULT_PRICING;
  return (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
}

/** Map from PatchableAgent to base prompt constant */
const BASE_PROMPTS: Record<string, string> = {
  regime: REGIME_SYSTEM_PROMPT,
  edge: EDGE_SYSTEM_PROMPT,
  supervisor: SUPERVISOR_SYSTEM_PROMPT,
};

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

export interface EvalTriggerRequest {
  orderId: string;
  windowId?: string;
  side: string;
  entryPrice: number;
  startPrice: number;
  endPrice: number;
  pnlUsd: number;
  outcome: string;
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
  parsedOutput: RegimeOutput | EdgeOutput | SupervisorOutput | GatekeeperOutput | EvalOutput;
  latencyMs: number;
  tokenUsage: { input: number; output: number };
  cached: boolean;
  createdAt: string;
}

// ─── Cache Entry ─────────────────────────────────────────────────────────────

interface CacheEntry {
  key: string;
  result: RegimeOutput | EdgeOutput | SupervisorOutput | GatekeeperOutput | EvalOutput;
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
  private gatekeeperModel = 'gpt-5.4-mini';
  private temperature = 0;
  private timeoutMs = 30_000;
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
    this.gatekeeperModel = process.env.GATEKEEPER_MODEL ?? this.gatekeeperModel;
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

    const systemPrompt = await this.getPatchedPrompt('regime');
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

    const systemPrompt = await this.getPatchedPrompt('edge');
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

    const systemPrompt = await this.getPatchedPrompt('supervisor');
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

  // ─── Eval Agent (post-loss prompt patching) ────────────────────────────────

  /**
   * Triggered by execution service after a losing trade.
   * Fetches trade context from DB, then calls evaluateEval.
   */
  async triggerEvalForLoss(payload: EvalTriggerRequest): Promise<Record<string, unknown>> {
    if (payload.outcome !== 'loss') {
      return { skipped: true, reason: 'not a loss' };
    }

    const { orderId, side, entryPrice, startPrice, endPrice, pnlUsd } = payload;

    // Fetch windowId from orders table
    const [order] = await this.db
      .select()
      .from(orders)
      .where(eq(orders.id, orderId))
      .limit(1);

    const windowId = payload.windowId ?? order?.windowId;
    if (!windowId) {
      this.logger.warn('Eval trigger: no windowId found', { orderId });
      return { skipped: true, reason: 'no windowId' };
    }

    // Fetch agent decisions for this window
    const decisions = await this.db
      .select()
      .from(agentDecisions)
      .where(eq(agentDecisions.windowId, windowId));

    const regimeDecision = decisions.find(d => d.agentType === 'regime');
    const edgeDecision = decisions.find(d => d.agentType === 'edge');
    const supervisorDecision = decisions.find(d => d.agentType === 'supervisor');

    if (!regimeDecision || !edgeDecision || !supervisorDecision) {
      this.logger.warn('Eval trigger: missing agent decisions', { windowId });
      return { skipped: true, reason: 'missing agent decisions' };
    }

    // Fetch feature snapshot
    const [featureRow] = await this.db
      .select()
      .from(featureSnapshots)
      .where(eq(featureSnapshots.windowId, windowId))
      .orderBy(desc(featureSnapshots.eventTime))
      .limit(1);

    // Build user prompt with trade context + current effective prompts (with patches applied)
    const [regimePrompt, edgePrompt, supervisorPrompt] = await Promise.all([
      this.getPatchedPrompt('regime'),
      this.getPatchedPrompt('edge'),
      this.getPatchedPrompt('supervisor'),
    ]);
    const currentPrompts: Record<PatchableAgent, string> = {
      regime: regimePrompt,
      edge: edgePrompt,
      supervisor: supervisorPrompt,
    };

    const userPrompt = JSON.stringify({
      trade: {
        orderId,
        windowId,
        side,
        entryPrice,
        startPrice,
        endPrice,
        pnlUsd,
        outcome: 'loss',
      },
      featuresAtDecision: featureRow?.payload ?? null,
      agentDecisions: {
        regime: regimeDecision.output,
        edge: edgeDecision.output,
        supervisor: supervisorDecision.output,
      },
      currentPrompts,
    }, null, 2);

    const result = await this.callAgent<EvalOutput>(
      'eval',
      windowId,
      EVAL_SYSTEM_PROMPT,
      userPrompt,
      EvalOutputSchema,
    );

    // Persist the patch for review
    const evalOutput = result.parsedOutput as unknown as EvalOutput;
    try {
      await this.db.insert(promptPatches).values({
        orderId,
        windowId,
        agentDecisionId: result.id,
        targetAgent: evalOutput.targetAgent,
        patchType: evalOutput.patchType,
        oldText: evalOutput.oldText,
        newText: evalOutput.newText,
        reasoning: evalOutput.reasoning,
        confidence: evalOutput.confidence,
        status: 'pending',
      });
    } catch {
      /* best-effort */
    }

    this.emitEvent('eval.patch.generated', {
      patchId: result.id,
      orderId,
      windowId,
      targetAgent: evalOutput.targetAgent,
      confidence: evalOutput.confidence,
    });

    this.logger.log(
      `[eval:${windowId}] Patch for ${evalOutput.targetAgent}: conf=${evalOutput.confidence}`,
    );

    return { triggered: true, traceId: result.id, targetAgent: evalOutput.targetAgent };
  }

  /**
   * Lists prompt patches for review.
   */
  async listPatches(status?: string, limit = 20) {
    const conditions = status ? [eq(promptPatches.status, status as 'pending' | 'approved' | 'rejected' | 'applied')] : [];
    return this.db
      .select()
      .from(promptPatches)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(promptPatches.createdAt))
      .limit(limit);
  }

  /**
   * Approves or rejects a prompt patch.
   */
  async reviewPatch(patchId: string, action: 'approve' | 'reject') {
    await this.db
      .update(promptPatches)
      .set({ status: action === 'approve' ? 'approved' : 'rejected', reviewedAt: new Date().toISOString() })
      .where(eq(promptPatches.id, patchId));
    return { updated: true };
  }

  /**
   * Applies an approved patch — sets status to 'applied'.
   * The patch takes effect immediately on next agent call via getPatchedPrompt().
   */
  async applyPatch(patchId: string) {
    const [patch] = await this.db
      .select()
      .from(promptPatches)
      .where(eq(promptPatches.id, patchId))
      .limit(1);

    if (!patch) throw new HttpException('Patch not found', HttpStatus.NOT_FOUND);
    if (patch.status !== 'approved') throw new HttpException('Patch must be approved before applying', HttpStatus.BAD_REQUEST);

    // Verify oldText still exists in the current effective prompt
    const currentPrompt = await this.getPatchedPrompt(patch.targetAgent as PatchableAgent);
    if (!currentPrompt.includes(patch.oldText)) {
      throw new HttpException(
        `oldText not found in current ${patch.targetAgent} prompt — may have been changed by another patch`,
        HttpStatus.CONFLICT,
      );
    }

    await this.db
      .update(promptPatches)
      .set({ status: 'applied', reviewedAt: new Date().toISOString() })
      .where(eq(promptPatches.id, patchId));

    this.logger.log(`Patch ${patchId} applied to ${patch.targetAgent}`);
    return { applied: true, targetAgent: patch.targetAgent };
  }

  /**
   * Resolves the effective prompt for a patchable agent by applying all 'applied' patches
   * in chronological order on top of the base prompt from the .ts file.
   */
  async getPatchedPrompt(agent: PatchableAgent): Promise<string> {
    const base = BASE_PROMPTS[agent];
    if (!base) return '';

    const patches = await this.db
      .select()
      .from(promptPatches)
      .where(and(
        eq(promptPatches.targetAgent, agent),
        eq(promptPatches.status, 'applied'),
      ))
      .orderBy(promptPatches.createdAt);

    let prompt = base;
    for (const patch of patches) {
      if (patch.patchType === 'insert_after') {
        prompt = prompt.replace(patch.oldText, patch.oldText + '\n' + patch.newText);
      } else {
        prompt = prompt.replace(patch.oldText, patch.newText);
      }
    }
    return prompt;
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
        tokenUsage: { input: r.inputTokens ?? 0, output: r.outputTokens ?? 0 },
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
        tokenUsage: { input: r.inputTokens ?? 0, output: r.outputTokens ?? 0 },
        cached: false,
        createdAt: new Date(r.processedAt).toISOString(),
      };
    }

    throw new HttpException(`Trace ${traceId} not found`, HttpStatus.NOT_FOUND);
  }

  // ─── Cost Stats ──────────────────────────────────────────────────────────

  async getCostStats() {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayMs = todayStart.getTime();

    // Aggregate from DB
    const [todayRows, allTimeRows] = await Promise.all([
      this.db
        .select({
          agentType: agentDecisions.agentType,
          totalInputTokens: sum(agentDecisions.inputTokens).mapWith(Number),
          totalOutputTokens: sum(agentDecisions.outputTokens).mapWith(Number),
          totalCostUsd: sum(agentDecisions.costUsd).mapWith(Number),
          callCount: sql<number>`count(*)`.mapWith(Number),
        })
        .from(agentDecisions)
        .where(gte(agentDecisions.processedAt, todayMs))
        .groupBy(agentDecisions.agentType),
      this.db
        .select({
          agentType: agentDecisions.agentType,
          totalInputTokens: sum(agentDecisions.inputTokens).mapWith(Number),
          totalOutputTokens: sum(agentDecisions.outputTokens).mapWith(Number),
          totalCostUsd: sum(agentDecisions.costUsd).mapWith(Number),
          callCount: sql<number>`count(*)`.mapWith(Number),
        })
        .from(agentDecisions)
        .groupBy(agentDecisions.agentType),
    ]);

    const todayCostUsd = todayRows.reduce((s, r) => s + (r.totalCostUsd ?? 0), 0);
    const allTimeCostUsd = allTimeRows.reduce((s, r) => s + (r.totalCostUsd ?? 0), 0);
    const todayCalls = todayRows.reduce((s, r) => s + (r.callCount ?? 0), 0);
    const allTimeCalls = allTimeRows.reduce((s, r) => s + (r.callCount ?? 0), 0);

    return {
      today: {
        totalCostUsd: todayCostUsd,
        totalCalls: todayCalls,
        byAgent: todayRows.map((r) => ({
          agentType: r.agentType,
          calls: r.callCount ?? 0,
          inputTokens: r.totalInputTokens ?? 0,
          outputTokens: r.totalOutputTokens ?? 0,
          costUsd: r.totalCostUsd ?? 0,
        })),
      },
      allTime: {
        totalCostUsd: allTimeCostUsd,
        totalCalls: allTimeCalls,
        byAgent: allTimeRows.map((r) => ({
          agentType: r.agentType,
          calls: r.callCount ?? 0,
          inputTokens: r.totalInputTokens ?? 0,
          outputTokens: r.totalOutputTokens ?? 0,
          costUsd: r.totalCostUsd ?? 0,
        })),
      },
    };
  }

  // ─── Core Agent Call ───────────────────────────────────────────────────────

  // Default reasoning effort per agent type
  private static readonly REASONING_EFFORT: Record<AgentType, ReasoningEffort> = {
    regime: 'medium',
    edge: 'medium',
    supervisor: 'high',
    gatekeeper: 'low',
    eval: 'high',
  };

  private async callAgent<T extends RegimeOutput | EdgeOutput | SupervisorOutput | GatekeeperOutput | EvalOutput>(
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
      const isGatekeeper = agentType === 'gatekeeper';
      const response = await this.llmClient.evaluate(systemPrompt, userPrompt, schema, {
        ...(modelOverride ? { model: modelOverride } : {}),
        reasoningEffort,
        ...(isGatekeeper ? { timeoutMs: this.gatekeeperTimeoutMs, maxRetries: 0 } : {}),
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
          inputTokens: tokenUsage.input,
          outputTokens: tokenUsage.output,
          costUsd: calculateLlmCostUsd(response.model, tokenUsage.input, tokenUsage.output),
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
        ...this.buildTopWalletsPromptData(features),
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
        ...(features.whaleLlmSummary ? { whaleSummary: features.whaleLlmSummary } : {}),
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
          lagMs: features.price.lagMs,
          predictiveBasisBps: features.price.predictiveBasisBps,
          lagReliability: features.price.lagReliability,
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
        ...this.buildTopWalletsPromptData(features),
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
        ...(features.whaleLlmSummary ? { whaleSummary: features.whaleLlmSummary } : {}),
        ...(features.sweep ? { sweep: features.sweep } : {}),
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
            lagMs: features.price.lagMs,
            predictiveBasisBps: features.price.predictiveBasisBps,
            lagReliability: features.price.lagReliability,
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
        ...this.buildTopWalletsPromptData(features),
        ...(features.derivatives ? {
          derivatives: {
            fundingPressure: features.derivatives.fundingPressure,
            liquidationIntensity: features.derivatives.liquidationIntensity,
            liquidationImbalance: features.derivatives.liquidationImbalance,
            derivativesSentiment: features.derivatives.derivativesSentiment,
          },
        } : {}),
        ...this.buildBlockchainPromptData(features),
        ...(features.whaleLlmSummary ? { whaleSummary: features.whaleLlmSummary } : {}),
        ...(features.sweep ? { sweep: features.sweep } : {}),
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
          winStreak: (riskState as Record<string, unknown>).winStreak ?? 0,
          streakMultiplier: (riskState as Record<string, unknown>).streakMultiplier ?? 1.0,
        },
      },
      null,
      2,
    );
  }

  private buildTopWalletsPromptData(features: FeaturePayload): Record<string, unknown> {
    if (!features.topWallets || features.topWallets.length === 0) return {};
    return {
      topExchangeWallets1h: features.topWallets.map((w) => ({
        exchange: w.exchange,
        address: `${w.address.slice(0, 8)}...${w.address.slice(-4)}`,
        volumeBtc: w.volumeBtc,
        volumeUsd: w.volumeUsd,
        txCount: w.txCount,
        netFlowBtc: w.netFlowBtc,
        lastSeenAgoSec: Math.round((Date.now() - w.lastSeenTime) / 1000),
      })),
    };
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

  private setCache(key: string, result: RegimeOutput | EdgeOutput | SupervisorOutput | GatekeeperOutput | EvalOutput): void {
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
