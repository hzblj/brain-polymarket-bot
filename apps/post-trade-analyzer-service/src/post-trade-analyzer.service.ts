import { DATABASE_CLIENT, type DbClient, tradeAnalyses } from '@brain/database';
import { EventBus } from '@brain/events';
import { OpenAIClient } from '@brain/llm-clients';
import { BrainLoggerService } from '@brain/logger';
import { TradeAnalysisLlmOutputSchema } from '@brain/schemas';
import type {
  AnalysisVerdict,
  ConfidenceCalibration,
  EdgeDirection,
  OrderSide,
  Regime,
  TradeAnalysis,
} from '@brain/types';
import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { desc, eq, and, gte, lte } from 'drizzle-orm';

// ─── Request / Response Types ────────────────────────────────────────────────

export interface AnalyzeRequest {
  orderId: string;
  windowId: string;
}

export interface AnalyzeWindowRequest {
  windowId: string;
}

export interface ListAnalysesFilter {
  windowId?: string;
  verdict?: string;
  from?: string;
  to?: string;
  limit: number;
}

// ─── Trade Context (fetched from sibling services) ──────────────────────────

interface TradeContext {
  order: {
    id: string;
    windowId: string;
    side: OrderSide;
    sizeUsd: number;
    entryPrice: number;
    mode: string;
    status: string;
  };
  fill: {
    fillPrice: number;
    fillSizeUsd: number;
    filledAt: string;
  } | null;
  features: {
    price: Record<string, unknown>;
    book: Record<string, unknown>;
    signals: Record<string, unknown>;
    market: Record<string, unknown>;
    whales?: Record<string, unknown>;
    derivatives?: Record<string, unknown>;
    blockchain?: Record<string, unknown>;
  } | null;
  agentDecisions: {
    regime: { regime: string; confidence: number; reasoning: string } | null;
    edge: { direction: string; magnitude: number; confidence: number; reasoning: string } | null;
    supervisor: { action: string; sizeUsd: number; confidence: number; reasoning: string } | null;
  };
  riskEvaluation: {
    approved: boolean;
    approvedSizeUsd: number;
    rejectionReasons: string[];
  } | null;
  windowOutcome: 'up' | 'down' | 'flat' | 'unknown';
}

// ─── System Prompt ──────────────────────────────────────────────────────────

const TRADE_ANALYSIS_SYSTEM_PROMPT = `You are a post-trade analysis agent for a Polymarket BTC 5-minute binary options trading system.

Your job: analyze a completed trade to determine what went right, what went wrong, and what could be improved.

## Context

You will receive the full trade context:
- Feature snapshot at the time the decision was made (price data, orderbook data with liquidity depth, signals)
- Whale on-chain data: exchange flow pressure, abnormal activity score, whale volume
- Derivatives data: funding pressure, OI trend, liquidation intensity, sentiment
- Blockchain activity (1h window): mempool stats, fee rates, notable transaction flows, exchange inflows/outflows, activity trend
- Agent decisions: the regime agent's classification, the edge agent's assessment, and the supervisor's trade decision
- Risk evaluation: whether risk approved and at what size
- Trade execution: entry price, fill size, order side
- Market outcome: whether BTC went up or down at window expiry, and the actual P&L

## Analysis Framework

1. **Edge Accuracy**: Was the edge agent's directional call correct? If it predicted "up" with 0.08 magnitude, did the market actually go up? Was the magnitude realistic?
2. **Regime Relevance**: Did the regime classification help or hinder? For example, if regime was "trending_up" but the market reversed, the regime was misleading.
3. **Misleading Signals**: Which specific input signals pointed in the wrong direction? Check ALL data sources:
   - Price signals: momentum, volatility, returnBps, basisBps
   - Book signals: imbalance, depthScore, spreadBps, bidDepthUsd/askDepthUsd (liquidity)
   - Whale signals: exchangeFlowPressure, abnormalActivityScore
   - Derivatives signals: fundingPressure, liquidationIntensity, derivativesSentiment
   - Blockchain signals: exchange inflows/outflows, fee rates, mempool congestion, activity trend
   Be specific — name the signal, its value, and what it implied vs what happened.
4. **Correct Signals**: Which signals correctly predicted the outcome across all data sources? This helps identify which inputs are reliable.
5. **Confidence Calibration**: Was the supervisor's confidence appropriate? If confidence was 0.8 but the trade lost, that suggests overconfidence. If confidence was 0.4 and the trade won big, that suggests underconfidence.
6. **Signal Confluence Analysis**: Did the different data sources agree or conflict? E.g., "whale outflows suggested bullish but derivatives funding was crowded long — conflicting signals should have reduced confidence."
7. **Improvement Suggestions**: Concrete, actionable suggestions. Examples: "Reduce position size when blockchain exchange inflows contradict the edge direction", "The low book depth ($200 total) made this trade high-slippage risk", "Ignore whale signals when abnormalActivityScore < 0.2".

Rules:
- Be brutally honest. If the agents made a bad call, say so clearly.
- Reference specific numeric values from the input — don't be vague.
- For misleadingSignals and correctSignals, use format like "momentum=0.42 suggested upward trend but market fell".
- improvementSuggestions should be actionable system-level changes, not generic advice.
- Never fabricate data. Only reference values present in the input.`;

// ─── Service URLs ───────────────────────────────────────────────────────────

const LOCAL_HOST = process.env.LOCAL_IP ?? 'localhost';
const EXECUTION_SERVICE_URL = process.env.EXECUTION_SERVICE_URL ?? `http://${LOCAL_HOST}:3006`;
const FEATURE_ENGINE_URL = process.env.FEATURE_ENGINE_URL ?? `http://${LOCAL_HOST}:3004`;
const AGENT_GATEWAY_URL = process.env.AGENT_GATEWAY_URL ?? `http://${LOCAL_HOST}:3008`;
const RISK_SERVICE_URL = process.env.RISK_SERVICE_URL ?? `http://${LOCAL_HOST}:3005`;
const MARKET_DISCOVERY_URL = process.env.MARKET_DISCOVERY_URL ?? `http://${LOCAL_HOST}:3001`;

// ─── Service ────────────────────────────────────────────────────────────────

@Injectable()
export class PostTradeAnalyzerService {
  constructor(
    @Inject(DATABASE_CLIENT) private readonly db: DbClient,
    @Inject(EventBus) private readonly eventBus: EventBus,
    @Inject(OpenAIClient) private readonly llmClient: OpenAIClient,
    @Inject(BrainLoggerService) private readonly logger: BrainLoggerService,
  ) {}

  // ─── Public API ──────────────────────────────────────────────────────────

  async analyze(request: AnalyzeRequest): Promise<TradeAnalysis> {
    this.logger.info('Starting trade analysis', {
      orderId: request.orderId,
      windowId: request.windowId,
    });

    const context = await this.fetchTradeContext(request.orderId, request.windowId);

    if (!context.fill) {
      throw new HttpException('Order has no fill — cannot analyze unfilled trade', HttpStatus.BAD_REQUEST);
    }

    const pnl = this.computePnl(context);
    const analysis = await this.runLlmAnalysis(context, pnl);

    try {
      await this.db.insert(tradeAnalyses).values({
        id: analysis.id,
        windowId: analysis.windowId,
        orderId: analysis.orderId,
        verdict: analysis.verdict,
        pnlUsd: analysis.pnlUsd,
        pnlBps: analysis.pnlBps,
        entryPrice: analysis.entryPrice,
        exitPrice: analysis.exitPrice,
        side: analysis.side,
        sizeUsd: analysis.sizeUsd,
        regimeAtEntry: analysis.regimeAtEntry,
        edgeDirectionAtEntry: analysis.edgeDirectionAtEntry,
        edgeMagnitudeAtEntry: analysis.edgeMagnitudeAtEntry,
        supervisorConfidence: analysis.supervisorConfidence,
        edgeAccurate: analysis.edgeAccurate,
        confidenceCalibration: analysis.confidenceCalibration,
        misleadingSignals: analysis.misleadingSignals,
        correctSignals: analysis.correctSignals,
        improvementSuggestions: analysis.improvementSuggestions,
        llmReasoning: analysis.llmReasoning,
        model: analysis.model,
        provider: analysis.provider,
        latencyMs: analysis.latencyMs,
      });
    } catch (_dbError) {
      this.logger.warn('Failed to persist trade analysis to database');
    }

    this.eventBus.emit('trade.analysis.completed', {
      analysisId: analysis.id,
      windowId: analysis.windowId,
      orderId: analysis.orderId,
      profitable: analysis.verdict === 'profitable',
      pnlUsd: analysis.pnlUsd,
    });

    this.logger.info('Trade analysis completed', {
      analysisId: analysis.id,
      verdict: analysis.verdict,
      pnlUsd: analysis.pnlUsd,
    });

    return analysis;
  }

  async analyzeWindow(request: AnalyzeWindowRequest): Promise<TradeAnalysis[]> {
    const ordersData = await this.fetchJson<{ ok: boolean; data: Array<{ id: string }> }>(
      `${EXECUTION_SERVICE_URL}/api/v1/execution/orders?windowId=${request.windowId}`,
    );

    if (!ordersData?.data?.length) {
      return [];
    }

    const results: TradeAnalysis[] = [];
    for (const order of ordersData.data) {
      try {
        const analysis = await this.analyze({ orderId: order.id, windowId: request.windowId });
        results.push(analysis);
      } catch (error) {
        this.logger.warn(`Failed to analyze order ${order.id}: ${(error as Error).message}`);
      }
    }

    return results;
  }

  async listAnalyses(filter: ListAnalysesFilter) {
    const conditions = [];

    if (filter.windowId) {
      conditions.push(eq(tradeAnalyses.windowId, filter.windowId));
    }
    if (filter.verdict) {
      conditions.push(eq(tradeAnalyses.verdict, filter.verdict as TradeAnalysis['verdict']));
    }
    if (filter.from) {
      conditions.push(gte(tradeAnalyses.createdAt, filter.from));
    }
    if (filter.to) {
      conditions.push(lte(tradeAnalyses.createdAt, filter.to));
    }

    const query = this.db
      .select()
      .from(tradeAnalyses)
      .orderBy(desc(tradeAnalyses.createdAt))
      .limit(filter.limit);

    if (conditions.length > 0) {
      return query.where(and(...conditions));
    }

    return query;
  }

  async getAnalysis(id: string) {
    const rows = await this.db.select().from(tradeAnalyses).where(eq(tradeAnalyses.id, id)).limit(1);
    if (!rows.length) {
      throw new HttpException('Analysis not found', HttpStatus.NOT_FOUND);
    }
    return rows[0];
  }

  // ─── Private: Fetch Trade Context ────────────────────────────────────────

  private async fetchTradeContext(orderId: string, windowId: string): Promise<TradeContext> {
    const [orderData, featuresData, agentData, riskData, windowData] = await Promise.all([
      this.fetchJson<{ ok: boolean; data: TradeContext['order'] & { fills?: TradeContext['fill'][] } }>(
        `${EXECUTION_SERVICE_URL}/api/v1/execution/orders/${orderId}`,
      ),
      this.fetchJson<{ ok: boolean; data: { payload?: TradeContext['features'] } }>(
        `${FEATURE_ENGINE_URL}/api/v1/features/latest?windowId=${windowId}`,
      ),
      this.fetchJson<{
        ok: boolean;
        data: Array<{
          agentType: string;
          output: Record<string, unknown>;
        }>;
      }>(`${AGENT_GATEWAY_URL}/api/v1/agent/traces?windowId=${windowId}`),
      this.fetchJson<{ ok: boolean; data: Array<TradeContext['riskEvaluation']> }>(
        `${RISK_SERVICE_URL}/api/v1/risk/decisions?windowId=${windowId}`,
      ),
      this.fetchJson<{
        ok: boolean;
        data: { outcome?: string };
      }>(`${MARKET_DISCOVERY_URL}/api/v1/markets/windows/${windowId}`),
    ]);

    const order = orderData?.data ?? {
      id: orderId,
      windowId,
      side: 'buy_up' as const,
      sizeUsd: 0,
      entryPrice: 0,
      mode: 'paper',
      status: 'filled',
    };

    const fillsArr = (orderData?.data as Record<string, unknown>)?.fills;
    const fill: TradeContext['fill'] =
      Array.isArray(fillsArr) && fillsArr.length > 0
        ? (fillsArr[0] as TradeContext['fill'])
        : null;

    const features = featuresData?.data?.payload ?? null;

    const agentDecisionsList = agentData?.data ?? [];
    const regimeDecision = agentDecisionsList.find((d) => d.agentType === 'regime');
    const edgeDecision = agentDecisionsList.find((d) => d.agentType === 'edge');
    const supervisorDecision = agentDecisionsList.find((d) => d.agentType === 'supervisor');

    const riskEval = riskData?.data?.[0] ?? null;
    const windowOutcome = (windowData?.data?.outcome as TradeContext['windowOutcome']) ?? 'unknown';

    return {
      order,
      fill,
      features,
      agentDecisions: {
        regime: regimeDecision
          ? (regimeDecision.output as TradeContext['agentDecisions']['regime'])
          : null,
        edge: edgeDecision
          ? (edgeDecision.output as TradeContext['agentDecisions']['edge'])
          : null,
        supervisor: supervisorDecision
          ? (supervisorDecision.output as TradeContext['agentDecisions']['supervisor'])
          : null,
      },
      riskEvaluation: riskEval,
      windowOutcome,
    };
  }

  // ─── Private: Compute P&L ────────────────────────────────────────────────

  private computePnl(context: TradeContext): {
    pnlUsd: number;
    pnlBps: number;
    verdict: AnalysisVerdict;
    exitPrice: number;
  } {
    const { order, fill, windowOutcome } = context;
    const entryPrice = fill?.fillPrice ?? order.entryPrice;
    const sizeUsd = fill?.fillSizeUsd ?? order.sizeUsd;

    // Binary options: if buy_up and outcome is up, payout = (1 - entryPrice) * size
    // If buy_up and outcome is down, loss = entryPrice * size
    let pnlUsd = 0;
    let exitPrice = 0;

    if (windowOutcome === 'unknown') {
      return { pnlUsd: 0, pnlBps: 0, verdict: 'unknown', exitPrice: 0 };
    }

    if (order.side === 'buy_up') {
      if (windowOutcome === 'up') {
        exitPrice = 1;
        pnlUsd = (1 - entryPrice) * sizeUsd;
      } else {
        exitPrice = 0;
        pnlUsd = -entryPrice * sizeUsd;
      }
    } else {
      // buy_down
      if (windowOutcome === 'down') {
        exitPrice = 1;
        pnlUsd = (1 - entryPrice) * sizeUsd;
      } else {
        exitPrice = 0;
        pnlUsd = -entryPrice * sizeUsd;
      }
    }

    const pnlBps = sizeUsd > 0 ? (pnlUsd / sizeUsd) * 10000 : 0;
    const verdict: AnalysisVerdict =
      pnlUsd > 0.01 ? 'profitable' : pnlUsd < -0.01 ? 'unprofitable' : 'breakeven';

    return { pnlUsd, pnlBps, verdict, exitPrice };
  }

  // ─── Private: LLM Analysis ───────────────────────────────────────────────

  private async runLlmAnalysis(
    context: TradeContext,
    pnl: { pnlUsd: number; pnlBps: number; verdict: AnalysisVerdict; exitPrice: number },
  ): Promise<TradeAnalysis> {
    const userPrompt = JSON.stringify(
      {
        trade: {
          orderId: context.order.id,
          windowId: context.order.windowId,
          side: context.order.side,
          sizeUsd: context.fill?.fillSizeUsd ?? context.order.sizeUsd,
          entryPrice: context.fill?.fillPrice ?? context.order.entryPrice,
          exitPrice: pnl.exitPrice,
          pnlUsd: pnl.pnlUsd,
          verdict: pnl.verdict,
          windowOutcome: context.windowOutcome,
        },
        featuresAtDecision: context.features,
        agentDecisions: context.agentDecisions,
        riskEvaluation: context.riskEvaluation,
      },
      null,
      2,
    );

    const llmResponse = await this.llmClient.evaluate(
      TRADE_ANALYSIS_SYSTEM_PROMPT,
      userPrompt,
      TradeAnalysisLlmOutputSchema,
    );

    const regimeAtEntry =
      (context.agentDecisions.regime?.regime as Regime) ?? 'quiet';
    const edgeDirection =
      (context.agentDecisions.edge?.direction as EdgeDirection) ?? 'none';
    const edgeMagnitude = context.agentDecisions.edge?.magnitude ?? 0;
    const supervisorConfidence = context.agentDecisions.supervisor?.confidence ?? 0;

    return {
      id: `analysis-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      windowId: context.order.windowId,
      orderId: context.order.id,
      verdict: pnl.verdict,
      pnlUsd: pnl.pnlUsd,
      pnlBps: pnl.pnlBps,
      entryPrice: context.fill?.fillPrice ?? context.order.entryPrice,
      exitPrice: pnl.exitPrice,
      side: context.order.side,
      sizeUsd: context.fill?.fillSizeUsd ?? context.order.sizeUsd,
      regimeAtEntry,
      edgeDirectionAtEntry: edgeDirection,
      edgeMagnitudeAtEntry: edgeMagnitude,
      supervisorConfidence,
      edgeAccurate: llmResponse.data.edgeAccurate,
      confidenceCalibration: llmResponse.data.confidenceCalibration as ConfidenceCalibration,
      misleadingSignals: llmResponse.data.misleadingSignals,
      correctSignals: llmResponse.data.correctSignals,
      improvementSuggestions: llmResponse.data.improvementSuggestions,
      llmReasoning: llmResponse.data.reasoning,
      model: llmResponse.model,
      provider: llmResponse.provider,
      latencyMs: llmResponse.latencyMs,
      createdAt: new Date().toISOString(),
    };
  }

  // ─── Private: HTTP Helpers ───────────────────────────────────────────────

  private async fetchJson<T>(url: string): Promise<T | null> {
    try {
      const response = await fetch(url, {
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) return null;
      return (await response.json()) as T;
    } catch {
      this.logger.warn(`Failed to fetch ${url}`);
      return null;
    }
  }
}
