import { agentDecisions, DATABASE_CLIENT, type DbClient } from '@brain/database';
import { EdgeOutputSchema, RegimeOutputSchema, SupervisorOutputSchema } from '@brain/schemas';
import type {
  AgentType,
  EdgeOutput,
  FeaturePayload,
  RegimeOutput,
  RiskConfig,
  RiskState,
  SupervisorOutput,
  UnixMs,
} from '@brain/types';
import { HttpException, HttpStatus, Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import type { z } from 'zod';

// ─── System Prompts ──────────────────────────────────────────────────────────

export const REGIME_SYSTEM_PROMPT = `You are a market regime classification agent for a Polymarket BTC 5-minute binary options trading system.

Your job: analyze the provided feature snapshot and classify the current market regime into exactly one category.

## Regime Categories

- **trending_up**: BTC price shows sustained upward momentum. Indicators: positive momentum score, positive return over the window, increasing tick rate, bid-side book pressure.
- **trending_down**: BTC price shows sustained downward momentum. Indicators: negative momentum score, negative return over the window, increasing tick rate, ask-side book pressure.
- **mean_reverting**: Price oscillates around a mean with no clear directional trend. Indicators: high mean reversion strength, low absolute momentum, mixed book pressure, moderate volatility.
- **volatile**: High uncertainty with rapid price swings in both directions. Indicators: high volatility, high tick rate, wide spreads, low depth scores. This regime is dangerous for directional bets.
- **quiet**: Very low activity and price movement. Indicators: low volatility, low tick rate, narrow spreads, neutral book pressure. Edges are unlikely in this regime.

## Analysis Framework

1. Examine the price features: returnBps, momentum, volatility, meanReversionStrength, tickRate
2. Examine the book features: spreadBps, depthScore, imbalance
3. Examine the signal features: priceDirectionScore, volatilityRegime, bookPressure, basisSignal
4. Examine the basis between exchange mid price and Polymarket mid price
5. Consider how much time remains in the window (remainingMs) — regimes can shift as windows close

## Output Format

Respond with ONLY a JSON object (no markdown, no explanation outside the JSON):
{
  "regime": "trending_up" | "trending_down" | "mean_reverting" | "volatile" | "quiet",
  "confidence": <number 0-1>,
  "reasoning": "<1-3 sentences explaining the classification>"
}

Rules:
- Confidence should reflect how clearly the data fits the regime. If ambiguous, use 0.3-0.5.
- If volatility is extreme (regime "high") AND momentum is low, prefer "volatile" over trending.
- If remaining time is under 60 seconds, bias toward "quiet" unless momentum is very strong.
- Never fabricate data points. Only reference values present in the input.`;

export const EDGE_SYSTEM_PROMPT = `You are an edge estimation agent for a Polymarket BTC 5-minute binary options trading system.

Your job: estimate the fair probability that BTC will be UP vs DOWN at window expiry, and determine if there is a tradeable edge against the current Polymarket prices.

## Context

On Polymarket, the "UP" token pays $1 if BTC price at window end > BTC price at window start, and $0 otherwise. The "DOWN" token is the complement. You are given the current orderbook prices (upBid, upAsk, downBid, downAsk) and the feature payload with real-time market data.

## Analysis Framework

1. **Directional probability**: Use price momentum, return since window open, mean reversion strength, and exchange price movements to estimate P(UP).
2. **Market price**: The Polymarket mid price for UP is approximately (upBid + upAsk) / 2. This is the market's implied probability.
3. **Edge**: edge = |fair_probability - market_probability|. Only flag an edge if it exceeds a meaningful threshold (typically 5+ cents / 5%).
4. **Direction**: If your fair P(UP) > market P(UP), direction is "up". If fair P(UP) < market P(UP), direction is "down". If no meaningful edge, direction is "none".
5. **Adjustments**:
   - High volatility reduces confidence in directional calls
   - Low time remaining (< 60s) means momentum carries more weight
   - Large basis between exchange and Polymarket suggests possible mispricing
   - Low depth scores mean edge may not be executable

## Output Format

Respond with ONLY a JSON object (no markdown, no explanation outside the JSON):
{
  "direction": "up" | "down" | "none",
  "magnitude": <number 0-1, how large the edge is in probability terms>,
  "confidence": <number 0-1>,
  "reasoning": "<1-3 sentences explaining the edge assessment>"
}

Rules:
- If no clear edge exists (magnitude < 0.03), set direction to "none" and magnitude to 0.
- Confidence reflects how certain you are about the edge, NOT the direction of BTC.
- A 0.05 edge at 0.8 confidence is a strong signal. A 0.15 edge at 0.3 confidence is weak.
- Be conservative. Most 5-minute windows have no meaningful edge.
- Never fabricate data. Only reference values present in the input.`;

export const SUPERVISOR_SYSTEM_PROMPT = `You are the supervisor agent for a Polymarket BTC 5-minute binary options trading system.

Your job: synthesize the regime classification, edge assessment, and risk state into a single trade decision. You are the final decision maker before risk checks.

## Input

You receive:
1. **Feature payload**: Full real-time market data
2. **Regime output**: Classification from the regime agent (trending_up/trending_down/mean_reverting/volatile/quiet)
3. **Edge output**: Edge assessment from the edge agent (direction, magnitude, confidence)
4. **Risk state**: Current daily P&L, open exposure, trades this window, risk config limits

## Decision Framework

### When to BUY_UP:
- Regime is trending_up AND edge direction is "up" with magnitude > 0.05 and confidence > 0.5
- OR: Regime is mean_reverting AND price has fallen significantly AND edge direction is "up" with high confidence
- Risk state allows: daily loss limit not breached, position size within limits

### When to BUY_DOWN:
- Regime is trending_down AND edge direction is "down" with magnitude > 0.05 and confidence > 0.5
- OR: Regime is mean_reverting AND price has risen significantly AND edge direction is "down" with high confidence
- Risk state allows: daily loss limit not breached, position size within limits

### When to HOLD (no trade):
- Regime is "volatile" — too much uncertainty
- Regime is "quiet" — no edge to capture
- Edge direction is "none" or magnitude < 0.03
- Edge confidence < 0.4
- Risk state is stressed: daily P&L near loss limit, too many trades this window
- Remaining time < 30 seconds — too late to enter
- Spread is too wide relative to edge

### Position Sizing:
- Base size: $10-15 for moderate edges (0.05-0.10 magnitude)
- Larger size: $20-30 for strong edges (0.10+ magnitude, 0.7+ confidence)
- Maximum: respect the maxSizeUsd from risk config
- Scale down if daily P&L is negative
- Scale down if confidence is below 0.6

## Output Format

Respond with ONLY a JSON object (no markdown, no explanation outside the JSON):
{
  "action": "buy_up" | "buy_down" | "hold",
  "sizeUsd": <number, 0 if hold>,
  "confidence": <number 0-1>,
  "reasoning": "<2-4 sentences explaining the decision>",
  "regimeSummary": "<1 sentence summarizing the regime context>",
  "edgeSummary": "<1 sentence summarizing the edge assessment>"
}

Rules:
- Default to HOLD. Only trade when regime, edge, and risk all align.
- Never exceed maxSizeUsd from risk config.
- If sizeUsd > 0 but action is "hold", that is invalid. Size must be 0 for hold.
- Be honest in reasoning. If the edge is marginal, say so.
- You do NOT place orders. You propose a trade. The risk service and execution service handle the rest.
- Never fabricate data. Only reference values from the input.`;

// ─── Request / Response Types ────────────────────────────────────────────────

export interface RegimeEvaluationRequest {
  windowId: string;
  features: FeaturePayload;
}

export interface EdgeEvaluationRequest {
  windowId: string;
  features: FeaturePayload;
}

export interface SupervisorEvaluationRequest {
  windowId: string;
  features: FeaturePayload;
  regime: RegimeOutput;
  edge: EdgeOutput;
  riskState: RiskState;
  riskConfig: RiskConfig;
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
  parsedOutput: RegimeOutput | EdgeOutput | SupervisorOutput;
  latencyMs: number;
  tokenUsage: { input: number; output: number };
  cached: boolean;
  createdAt: string;
}

// ─── Cache Entry ─────────────────────────────────────────────────────────────

interface CacheEntry {
  key: string;
  result: RegimeOutput | EdgeOutput | SupervisorOutput;
  createdAt: number;
}

const CACHE_TTL_MS = 5_000; // 5 second cache for identical requests within same window

@Injectable()
export class AgentGatewayService implements OnModuleInit {
  private traces: Map<string, AgentTrace> = new Map();
  private cache: Map<string, CacheEntry> = new Map();

  // Default config — will be overridden by env / config-service
  private provider: 'anthropic' | 'openai' = 'anthropic';
  private model = 'claude-sonnet-4-20250514';
  private temperature = 0;
  private timeoutMs = 30_000;
  private maxRetries = 2;

  constructor(@Inject(DATABASE_CLIENT) private readonly db: DbClient) {}

  onModuleInit(): void {
    // Load config from env
    this.provider = (process.env.AGENT_PROVIDER as 'anthropic' | 'openai') ?? this.provider;
    this.model = process.env.AGENT_MODEL ?? this.model;
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
    const { windowId, features } = request;

    // Check cache
    const cacheKey = this.buildCacheKey('regime', windowId, features.eventTime);
    const cached = this.getFromCache(cacheKey);
    if (cached) {
      const trace = this.findTraceByCache(cacheKey);
      if (trace) return { ...trace, cached: true };
    }

    const userPrompt = this.buildRegimeUserPrompt(features);
    const result = await this.callAgent<RegimeOutput>(
      'regime',
      windowId,
      REGIME_SYSTEM_PROMPT,
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
    const { windowId, features } = request;

    const cacheKey = this.buildCacheKey('edge', windowId, features.eventTime);
    const cached = this.getFromCache(cacheKey);
    if (cached) {
      const trace = this.findTraceByCache(cacheKey);
      if (trace) return { ...trace, cached: true };
    }

    const userPrompt = this.buildEdgeUserPrompt(features);
    const result = await this.callAgent<EdgeOutput>(
      'edge',
      windowId,
      EDGE_SYSTEM_PROMPT,
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
    const { windowId, features, regime, edge, riskState, riskConfig } = request;

    const cacheKey = this.buildCacheKey('supervisor', windowId, features.eventTime);
    const cached = this.getFromCache(cacheKey);
    if (cached) {
      const trace = this.findTraceByCache(cacheKey);
      if (trace) return { ...trace, cached: true };
    }

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
      SUPERVISOR_SYSTEM_PROMPT,
      userPrompt,
      SupervisorOutputSchema,
    );

    this.setCache(cacheKey, result.parsedOutput);
    return result;
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
      parsedOutput: output as RegimeOutput | EdgeOutput | SupervisorOutput,
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
        parsedOutput: r.output as RegimeOutput | EdgeOutput | SupervisorOutput,
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
        parsedOutput: r.output as RegimeOutput | EdgeOutput | SupervisorOutput,
        latencyMs: r.latencyMs,
        tokenUsage: { input: 0, output: 0 },
        cached: false,
        createdAt: new Date(r.processedAt).toISOString(),
      };
    }

    throw new HttpException(`Trace ${traceId} not found`, HttpStatus.NOT_FOUND);
  }

  // ─── Core Agent Call ───────────────────────────────────────────────────────

  private async callAgent<T extends RegimeOutput | EdgeOutput | SupervisorOutput>(
    agentType: AgentType,
    windowId: string,
    systemPrompt: string,
    userPrompt: string,
    schema: z.ZodSchema<T>,
  ): Promise<AgentTrace> {
    const startMs = Date.now();
    let rawResponse = '';
    let parsedOutput: T;
    let tokenUsage = { input: 0, output: 0 };
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        // TODO: Replace with real LLM client call
        // const response = await this.llmClients.chat({
        //   provider: this.provider,
        //   model: this.model,
        //   temperature: this.temperature,
        //   timeoutMs: this.timeoutMs,
        //   messages: [
        //     { role: 'system', content: systemPrompt },
        //     { role: 'user', content: userPrompt },
        //   ],
        // });
        // rawResponse = response.content;
        // tokenUsage = { input: response.usage.inputTokens, output: response.usage.outputTokens };

        // Stub: generate a plausible response based on agent type
        const stubResult = this.generateStubResponse(agentType, userPrompt);
        rawResponse = JSON.stringify(stubResult);
        tokenUsage = { input: userPrompt.length, output: rawResponse.length };

        // Parse and validate with Zod
        const parsed = JSON.parse(rawResponse);
        parsedOutput = schema.parse(parsed);

        const latencyMs = Date.now() - startMs;

        const trace: AgentTrace = {
          id: `trace-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
          windowId,
          agentType,
          model: this.model,
          provider: this.provider,
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
            model: this.model,
            provider: this.provider,
            latencyMs,
            eventTime: Date.now(),
            processedAt: Date.now(),
          });
        } catch (_dbError) {
          /* best-effort persistence */
        }

        this.emitEvent(`agent.${agentType}.completed`, {
          traceId: trace.id,
          windowId,
          latencyMs,
          attempt,
        });
        return trace;
      } catch (error) {
        lastError = error as Error;

        if (attempt < this.maxRetries) {
          // Exponential backoff: 500ms, 1000ms, 2000ms
          await this.sleep(500 * 2 ** attempt);
        }
      }
    }

    // All retries exhausted
    this.emitEvent(`agent.${agentType}.failed`, {
      windowId,
      error: lastError?.message,
      attempts: this.maxRetries + 1,
    });

    throw new HttpException(
      `Agent ${agentType} failed after ${this.maxRetries + 1} attempts: ${lastError?.message}`,
      HttpStatus.SERVICE_UNAVAILABLE,
    );
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
        },
        signals: features.signals,
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
        },
        signals: features.signals,
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
          },
          signals: features.signals,
        },
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

  // ─── Stub Response Generator ───────────────────────────────────────────────

  private generateStubResponse(agentType: AgentType, _userPrompt: string): Record<string, unknown> {
    // Generates a plausible stub response for development/testing.
    // In production, this is replaced by real LLM calls.

    switch (agentType) {
      case 'regime':
        return {
          regime: 'mean_reverting',
          confidence: 0.55,
          reasoning:
            'Price shows moderate mean reversion strength with low directional momentum. Volatility is within normal range. Book pressure is neutral, suggesting no strong directional conviction.',
        };

      case 'edge':
        return {
          direction: 'none',
          magnitude: 0,
          confidence: 0.4,
          reasoning:
            'No significant edge detected. The Polymarket mid price is roughly in line with the fair value estimate. Spread is acceptable but the directional signal is weak.',
        };

      case 'supervisor':
        return {
          action: 'hold',
          sizeUsd: 0,
          confidence: 0.5,
          reasoning:
            'Holding. The regime is mean-reverting with no clear edge detected by the edge agent. Risk state is healthy but without a strong signal, entering a position is not justified.',
          regimeSummary: 'Market is in a mean-reverting regime with moderate confidence.',
          edgeSummary: 'No actionable edge identified in current pricing.',
        };

      default:
        throw new Error(`Unknown agent type: ${agentType}`);
    }
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

  private setCache(key: string, result: RegimeOutput | EdgeOutput | SupervisorOutput): void {
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

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private emitEvent(_event: string, _payload: Record<string, unknown>): void {
    /* noop */
  }
}
