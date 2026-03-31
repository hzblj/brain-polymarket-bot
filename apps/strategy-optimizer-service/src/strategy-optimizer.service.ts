import { DATABASE_CLIENT, type DbClient, dailyReports } from '@brain/database';
import { EventBus } from '@brain/events';
import { OpenAIClient } from '@brain/llm-clients';
import { BrainLoggerService } from '@brain/logger';
import { DailyReportLlmOutputSchema } from '@brain/schemas';
import type {
  AgentAccuracyMetrics,
  DailyReport,
  HourPerformance,
  RegimePerformance,
  RiskMetrics,
  StrategySuggestion,
} from '@brain/types';
import { HttpException, HttpStatus, Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { desc, gte, lte, and } from 'drizzle-orm';
import { eq } from 'drizzle-orm';

// ─── Request / Response Types ────────────────────────────────────────────────

export interface GenerateReportRequest {
  periodStart?: string;
  periodEnd?: string;
}

export interface ListReportsFilter {
  from?: string;
  to?: string;
  limit: number;
}

// ─── Trade Analysis (from post-trade-analyzer API) ──────────────────────────

interface TradeAnalysisData {
  id: string;
  windowId: string;
  orderId: string;
  verdict: string;
  pnlUsd: number;
  pnlBps: number;
  entryPrice: number;
  exitPrice: number;
  side: string;
  sizeUsd: number;
  regimeAtEntry: string;
  edgeDirectionAtEntry: string;
  edgeMagnitudeAtEntry: number;
  supervisorConfidence: number;
  edgeAccurate: boolean;
  confidenceCalibration: string;
  misleadingSignals: string[];
  correctSignals: string[];
  improvementSuggestions: string[];
  llmReasoning: string;
  createdAt: string;
}

// ─── System Prompt ──────────────────────────────────────────────────────────

const STRATEGY_REPORT_SYSTEM_PROMPT = `You are a strategy optimization agent for a Polymarket BTC 5-minute binary options trading system.

Your job: analyze a day's worth of trading data and produce actionable insights to improve the system's performance.

## Context

You receive:
1. Aggregate statistics: P&L, win rate, drawdown, trade count
2. Performance breakdown by market regime (trending_up, trending_down, mean_reverting, volatile, quiet)
3. Performance breakdown by time of day
4. Agent accuracy metrics: how often was the edge prediction accurate? How well calibrated were confidence scores?
5. Risk rejection analysis: how many proposals were rejected and why
6. Individual trade analyses: for each trade, a prior LLM analysis of what went right/wrong
7. Current strategy configuration: risk limits, decision policies

## Analysis Framework

1. **Pattern Recognition**: Look for systematic issues. Examples:
   - "Losing consistently in volatile regimes" -> suggest filtering out volatile regimes
   - "Win rate drops significantly after 3 PM UTC" -> suggest time-based trading restrictions
   - "Edge magnitude predictions are 2x too large" -> suggest magnitude calibration
   - "High-confidence trades have LOWER win rate than low-confidence" -> confidence model is broken

2. **Strategy Suggestions**: Each suggestion must be:
   - Specific: "Reduce maxSizeUsd from 50 to 30" not "Consider reducing position size"
   - Justified: backed by data from the statistics
   - Categorized: risk_limits, position_sizing, agent_prompts, regime_filters, timing, other
   - Rated for confidence and priority
   - Marked whether it can be auto-applied (pure parameter changes) or needs human review (prompt changes)

3. **Executive Summary**: A 2-4 sentence summary suitable for a daily email/notification.

Rules:
- If the system is performing well (win rate > 55%, positive P&L), say so and suggest marginal improvements.
- If the system is performing badly, be direct about the root causes.
- Suggestions with confidence < 0.3 should be omitted — only suggest things you're reasonably sure about.
- Reference specific numbers from the input. "Win rate in volatile regime was 20% vs 65% overall" is good. "Volatile regime performs poorly" is bad.
- If there are fewer than 5 trades in the period, note that sample size is too small for reliable conclusions but still provide observations.
- Never fabricate data.`;

// ─── Service URLs ───────────────────────────────────────────────────────────

const LOCAL_HOST = process.env.LOCAL_IP ?? 'localhost';
const POST_TRADE_ANALYZER_URL = process.env.POST_TRADE_ANALYZER_URL ?? `http://${LOCAL_HOST}:3011`;
const EXECUTION_SERVICE_URL = process.env.EXECUTION_SERVICE_URL ?? `http://${LOCAL_HOST}:3006`;
const RISK_SERVICE_URL = process.env.RISK_SERVICE_URL ?? `http://${LOCAL_HOST}:3005`;
const CONFIG_SERVICE_URL = process.env.CONFIG_SERVICE_URL ?? `http://${LOCAL_HOST}:3007`;

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

// ─── Service ────────────────────────────────────────────────────────────────

@Injectable()
export class StrategyOptimizerService implements OnModuleInit, OnModuleDestroy {
  private schedulerTimer: ReturnType<typeof setInterval> | null = null;
  private tradeCountTimer: ReturnType<typeof setInterval> | null = null;
  private schedulerEnabled = true;
  private lastRunAt: string | null = null;
  private isRunning = false;
  private lastKnownTradeCount = 0;
  private tradesPerOptimization = parseInt(process.env.TRADES_PER_OPTIMIZATION ?? '10', 10);

  constructor(
    @Inject(DATABASE_CLIENT) private readonly db: DbClient,
    @Inject(EventBus) private readonly eventBus: EventBus,
    @Inject(OpenAIClient) private readonly llmClient: OpenAIClient,
    @Inject(BrainLoggerService) private readonly logger: BrainLoggerService,
  ) {}

  onModuleInit(): void {
    const intervalMs = process.env.OPTIMIZER_INTERVAL_MS
      ? parseInt(process.env.OPTIMIZER_INTERVAL_MS, 10)
      : DEFAULT_INTERVAL_MS;

    this.schedulerTimer = setInterval(() => {
      if (this.schedulerEnabled && !this.isRunning) {
        this.generateReport({}).catch((err) => {
          this.logger.error('Scheduled report generation failed', (err as Error).message);
        });
      }
    }, intervalMs);

    // Also poll for new trades every 60s — trigger optimization after N trades
    this.tradeCountTimer = setInterval(async () => {
      if (!this.schedulerEnabled || this.isRunning) return;
      await this.checkTradeCountTrigger();
    }, 60_000);

    this.logger.info('Strategy optimizer scheduler started', {
      intervalMs,
      enabled: this.schedulerEnabled,
      tradesPerOptimization: this.tradesPerOptimization,
    });
  }

  onModuleDestroy(): void {
    if (this.schedulerTimer) {
      clearInterval(this.schedulerTimer);
      this.schedulerTimer = null;
    }
    if (this.tradeCountTimer) {
      clearInterval(this.tradeCountTimer);
      this.tradeCountTimer = null;
    }
  }

  private async checkTradeCountTrigger(): Promise<void> {
    try {
      const res = await fetch(`${EXECUTION_SERVICE_URL}/api/v1/execution/resolved?limit=100`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) return;
      const json = (await res.json()) as { ok: boolean; data: unknown[] };
      if (!json.ok) return;

      const currentCount = json.data.length;
      const newTrades = currentCount - this.lastKnownTradeCount;

      if (newTrades >= this.tradesPerOptimization && this.lastKnownTradeCount > 0) {
        this.logger.info(`${newTrades} new trades since last optimization — triggering report`);
        this.lastKnownTradeCount = currentCount;
        await this.generateReport({});
      } else if (this.lastKnownTradeCount === 0) {
        // First check — just record count
        this.lastKnownTradeCount = currentCount;
      }
    } catch {
      /* best-effort */
    }
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  async generateReport(request: GenerateReportRequest): Promise<DailyReport> {
    this.isRunning = true;

    try {
      const periodEnd = request.periodEnd ?? new Date().toISOString();
      const periodStart =
        request.periodStart ??
        new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

      this.logger.info('Generating strategy report', { periodStart, periodEnd });

      // 1. Fetch trade analyses from the post-trade-analyzer
      const analyses = await this.fetchTradeAnalyses(periodStart, periodEnd);

      // 2. Fetch risk decisions for rejection stats
      const riskDecisions = await this.fetchRiskDecisions();

      // 3. Fetch current strategy config
      const strategyConfig = await this.fetchStrategyConfig();

      // 4. Compute aggregate statistics
      const stats = this.computeAggregateStats(analyses);
      const riskMetrics = this.computeRiskMetrics(riskDecisions, analyses.length);
      const agentAccuracy = this.computeAgentAccuracy(analyses);
      const performanceByRegime = this.computePerformanceByRegime(analyses);
      const performanceByHour = this.computePerformanceByHour(analyses);

      // 5. Run LLM analysis
      const llmInput = {
        period: { start: periodStart, end: periodEnd },
        aggregateStats: {
          totalTrades: stats.totalTrades,
          totalPnlUsd: stats.totalPnlUsd,
          winRate: stats.winRate,
          avgEdgeMagnitude: stats.avgEdgeMagnitude,
          maxDrawdownUsd: stats.maxDrawdownUsd,
        },
        performanceByRegime,
        performanceByHour,
        agentAccuracy,
        riskMetrics,
        tradeAnalyses: analyses.map((a) => ({
          verdict: a.verdict,
          pnlUsd: a.pnlUsd,
          regimeAtEntry: a.regimeAtEntry,
          edgeAccurate: a.edgeAccurate,
          supervisorConfidence: a.supervisorConfidence,
          confidenceCalibration: a.confidenceCalibration,
          misleadingSignals: a.misleadingSignals,
          improvementSuggestions: a.improvementSuggestions,
        })),
        currentStrategy: strategyConfig,
      };

      const llmResponse = await this.llmClient.evaluate(
        STRATEGY_REPORT_SYSTEM_PROMPT,
        JSON.stringify(llmInput, null, 2),
        DailyReportLlmOutputSchema,
      );

      const report: DailyReport = {
        id: `report-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        periodStart,
        periodEnd,
        totalTrades: stats.totalTrades,
        totalPnlUsd: stats.totalPnlUsd,
        winRate: stats.winRate,
        avgEdgeMagnitude: stats.avgEdgeMagnitude,
        maxDrawdownUsd: stats.maxDrawdownUsd,
        performanceByRegime,
        performanceByHour,
        agentAccuracy,
        riskMetrics,
        patterns: llmResponse.data.patterns,
        suggestions: llmResponse.data.suggestions as StrategySuggestion[],
        executiveSummary: llmResponse.data.executiveSummary,
        llmReasoning: llmResponse.data.reasoning,
        model: llmResponse.model,
        provider: llmResponse.provider,
        latencyMs: llmResponse.latencyMs,
        createdAt: new Date().toISOString(),
      };

      // 6. Persist
      try {
        await this.db.insert(dailyReports).values({
          id: report.id,
          periodStart: report.periodStart,
          periodEnd: report.periodEnd,
          totalTrades: report.totalTrades,
          totalPnlUsd: report.totalPnlUsd,
          winRate: report.winRate,
          avgEdgeMagnitude: report.avgEdgeMagnitude,
          maxDrawdownUsd: report.maxDrawdownUsd,
          performanceByRegime: report.performanceByRegime as Record<string, unknown>,
          performanceByHour: report.performanceByHour as Record<string, unknown>,
          agentAccuracy: report.agentAccuracy as unknown as Record<string, unknown>,
          riskMetrics: report.riskMetrics as unknown as Record<string, unknown>,
          patterns: report.patterns,
          suggestions: report.suggestions as unknown as Array<Record<string, unknown>>,
          executiveSummary: report.executiveSummary,
          llmReasoning: report.llmReasoning,
          model: report.model,
          provider: report.provider,
          latencyMs: report.latencyMs,
        });
      } catch (_dbError) {
        this.logger.warn('Failed to persist daily report to database');
      }

      // 7. Emit event
      this.eventBus.emit('strategy.report.generated', {
        reportId: report.id,
        periodStart: report.periodStart,
        periodEnd: report.periodEnd,
        totalPnlUsd: report.totalPnlUsd,
        tradeCount: report.totalTrades,
      });

      this.lastRunAt = new Date().toISOString();

      this.logger.info('Strategy report generated', {
        reportId: report.id,
        totalTrades: report.totalTrades,
        totalPnlUsd: report.totalPnlUsd,
        suggestionsCount: report.suggestions.length,
      });

      // 8. Auto-apply safe suggestions if enabled
      const autoApplyEnabled = process.env.AUTO_APPLY_ENABLED === 'true';
      if (autoApplyEnabled) {
        await this.autoApplySuggestions(report.suggestions);
      }

      return report;
    } finally {
      this.isRunning = false;
    }
  }

  async listReports(filter: ListReportsFilter) {
    const conditions = [];

    if (filter.from) {
      conditions.push(gte(dailyReports.createdAt, filter.from));
    }
    if (filter.to) {
      conditions.push(lte(dailyReports.createdAt, filter.to));
    }

    const query = this.db
      .select()
      .from(dailyReports)
      .orderBy(desc(dailyReports.createdAt))
      .limit(filter.limit);

    if (conditions.length > 0) {
      return query.where(and(...conditions));
    }

    return query;
  }

  async getReport(id: string) {
    const rows = await this.db
      .select()
      .from(dailyReports)
      .where(eq(dailyReports.id, id))
      .limit(1);
    if (!rows.length) {
      throw new HttpException('Report not found', HttpStatus.NOT_FOUND);
    }
    return rows[0];
  }

  getSchedulerStatus() {
    return {
      enabled: this.schedulerEnabled,
      isRunning: this.isRunning,
      lastRunAt: this.lastRunAt,
      intervalMs: process.env.OPTIMIZER_INTERVAL_MS
        ? parseInt(process.env.OPTIMIZER_INTERVAL_MS, 10)
        : DEFAULT_INTERVAL_MS,
    };
  }

  setSchedulerEnabled(enabled: boolean): void {
    this.schedulerEnabled = enabled;
    this.logger.info(`Scheduler ${enabled ? 'enabled' : 'disabled'}`);
  }

  // ─── Private: Auto-Apply Suggestions ────────────────────────────────────

  private async autoApplySuggestions(suggestions: StrategySuggestion[]): Promise<void> {
    const applicable = suggestions.filter(
      (s) => s.autoApplicable && s.confidence >= 0.5 && s.priority !== 'low',
    );

    if (applicable.length === 0) {
      this.logger.info('No auto-applicable suggestions');
      return;
    }

    this.logger.info(`Auto-applying ${applicable.length} suggestions`);

    for (const s of applicable) {
      try {
        const configUpdate = this.suggestionToConfigUpdate(s);
        if (!configUpdate) {
          this.logger.debug('Suggestion not mappable to config', { suggestion: s.suggestion });
          continue;
        }

        const res = await fetch(`${CONFIG_SERVICE_URL}/api/v1/config`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(configUpdate),
          signal: AbortSignal.timeout(5_000),
        });

        if (res.ok) {
          this.logger.info('Auto-applied suggestion', {
            category: s.category,
            suggestion: s.suggestion,
            config: configUpdate,
          });

          this.eventBus.emit('strategy.suggestion.applied', {
            category: s.category,
            suggestion: s.suggestion,
            confidence: s.confidence,
          });
        } else {
          this.logger.warn(`Failed to apply suggestion: HTTP ${res.status}`);
        }
      } catch (err) {
        this.logger.warn(`Failed to apply suggestion: ${(err as Error).message}`);
      }
    }
  }

  /**
   * Maps a text suggestion to a concrete config update.
   * Parses numbers from suggestion text for known parameter names.
   */
  private suggestionToConfigUpdate(s: StrategySuggestion): Record<string, unknown> | null {
    const text = s.suggestion.toLowerCase();

    const extractNum = (match: RegExpMatchArray | null): number | null => {
      const val = match?.[1];
      return val ? parseFloat(val) : null;
    };

    // Risk limit changes
    if (s.category === 'risk_limits') {
      const maxSize = extractNum(text.match(/maxsizeusd.*?(\d+\.?\d*)/i) ?? text.match(/max.*size.*\$?(\d+\.?\d*)/i));
      if (maxSize !== null) return { risk: { maxSizeUsd: maxSize } };

      const lossLimit = extractNum(text.match(/dailylosslimit.*?(\d+\.?\d*)/i) ?? text.match(/daily.*loss.*limit.*\$?(\d+\.?\d*)/i));
      if (lossLimit !== null) return { risk: { dailyLossLimitUsd: lossLimit } };

      const maxTrades = extractNum(text.match(/maxtradesperwindow.*?(\d+)/i) ?? text.match(/max.*trades.*window.*?(\d+)/i));
      if (maxTrades !== null) return { risk: { maxTradesPerWindow: Math.round(maxTrades) } };
    }

    // Position sizing
    if (s.category === 'position_sizing') {
      const size = extractNum(text.match(/\$?(\d+\.?\d*)/));
      if (size !== null) return { risk: { maxSizeUsd: size } };
    }

    // Regime filters / trading thresholds
    if (s.category === 'regime_filters') {
      const spread = extractNum(text.match(/spread.*?(\d+)/i));
      if (spread !== null) return { trading: { maxSpreadBps: Math.round(spread) } };

      const depth = extractNum(text.match(/depth.*?(\d+\.?\d*)/i));
      if (depth !== null) return { trading: { minDepthScore: depth } };
    }

    // Timing
    if (s.category === 'timing') {
      const startHour = extractNum(text.match(/start.*?(\d{1,2})\s*(?::00)?\s*utc/i));
      const endHour = extractNum(text.match(/end.*?(\d{1,2})\s*(?::00)?\s*utc/i));
      if (startHour !== null && endHour !== null) {
        return {
          trading: {
            tradingHoursUtc: { enabled: true, startHour: Math.round(startHour), endHour: Math.round(endHour) },
          },
        };
      }
    }

    return null;
  }

  // ─── Private: Data Fetching ──────────────────────────────────────────────

  private async fetchTradeAnalyses(
    periodStart: string,
    periodEnd: string,
  ): Promise<TradeAnalysisData[]> {
    const data = await this.fetchJson<{ ok: boolean; data: TradeAnalysisData[] }>(
      `${POST_TRADE_ANALYZER_URL}/api/v1/analyzer/analyses?from=${encodeURIComponent(periodStart)}&to=${encodeURIComponent(periodEnd)}&limit=500`,
    );
    return data?.data ?? [];
  }

  private async fetchRiskDecisions(): Promise<
    Array<{ approved: boolean; rejectionReasons: string[] }>
  > {
    const data = await this.fetchJson<{
      ok: boolean;
      data: Array<{ approved: boolean; rejectionReasons: string[] }>;
    }>(`${RISK_SERVICE_URL}/api/v1/risk/decisions?limit=500`);
    return data?.data ?? [];
  }

  private async fetchStrategyConfig(): Promise<Record<string, unknown> | null> {
    const data = await this.fetchJson<{ ok: boolean; data: Record<string, unknown> }>(
      `${CONFIG_SERVICE_URL}/api/v1/config/strategy`,
    );
    return data?.data ?? null;
  }

  // ─── Private: Aggregate Stats ────────────────────────────────────────────

  private computeAggregateStats(analyses: TradeAnalysisData[]) {
    const totalTrades = analyses.length;
    const totalPnlUsd = analyses.reduce((sum, a) => sum + a.pnlUsd, 0);
    const wins = analyses.filter((a) => a.verdict === 'profitable').length;
    const winRate = totalTrades > 0 ? wins / totalTrades : 0;
    const avgEdgeMagnitude =
      totalTrades > 0
        ? analyses.reduce((sum, a) => sum + a.edgeMagnitudeAtEntry, 0) / totalTrades
        : 0;

    // Max drawdown: running peak-to-trough
    let peak = 0;
    let runningPnl = 0;
    let maxDrawdown = 0;
    for (const a of analyses) {
      runningPnl += a.pnlUsd;
      if (runningPnl > peak) peak = runningPnl;
      const drawdown = peak - runningPnl;
      if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    }

    return {
      totalTrades,
      totalPnlUsd: Math.round(totalPnlUsd * 100) / 100,
      winRate: Math.round(winRate * 1000) / 1000,
      avgEdgeMagnitude: Math.round(avgEdgeMagnitude * 1000) / 1000,
      maxDrawdownUsd: Math.round(maxDrawdown * 100) / 100,
    };
  }

  private computePerformanceByRegime(
    analyses: TradeAnalysisData[],
  ): Record<string, RegimePerformance> {
    const regimes: Record<string, { trades: number; pnlUsd: number; wins: number }> = {};

    for (const a of analyses) {
      const regime = a.regimeAtEntry || 'unknown';
      if (!regimes[regime]) {
        regimes[regime] = { trades: 0, pnlUsd: 0, wins: 0 };
      }
      regimes[regime].trades++;
      regimes[regime].pnlUsd += a.pnlUsd;
      if (a.verdict === 'profitable') regimes[regime].wins++;
    }

    const result: Record<string, RegimePerformance> = {};
    for (const [regime, data] of Object.entries(regimes)) {
      result[regime] = {
        trades: data.trades,
        pnlUsd: Math.round(data.pnlUsd * 100) / 100,
        winRate: data.trades > 0 ? Math.round((data.wins / data.trades) * 1000) / 1000 : 0,
      };
    }

    return result;
  }

  private computePerformanceByHour(
    analyses: TradeAnalysisData[],
  ): Record<string, HourPerformance> {
    const hours: Record<string, { trades: number; pnlUsd: number }> = {};

    for (const a of analyses) {
      const hour = new Date(a.createdAt).getUTCHours().toString();
      if (!hours[hour]) {
        hours[hour] = { trades: 0, pnlUsd: 0 };
      }
      hours[hour].trades++;
      hours[hour].pnlUsd += a.pnlUsd;
    }

    const result: Record<string, HourPerformance> = {};
    for (const [hour, data] of Object.entries(hours)) {
      result[hour] = {
        trades: data.trades,
        pnlUsd: Math.round(data.pnlUsd * 100) / 100,
      };
    }

    return result;
  }

  private computeAgentAccuracy(analyses: TradeAnalysisData[]): AgentAccuracyMetrics {
    if (analyses.length === 0) {
      return { edgePredictionAccuracy: 0, confidenceCalibration: 0, regimeAccuracy: 0 };
    }

    const edgeAccurateCount = analyses.filter((a) => a.edgeAccurate).length;
    const edgePredictionAccuracy = edgeAccurateCount / analyses.length;

    // Confidence calibration: correlation between confidence and correctness
    // Simple approach: compare avg confidence of winners vs losers
    const winners = analyses.filter((a) => a.verdict === 'profitable');
    const losers = analyses.filter((a) => a.verdict === 'unprofitable');
    const avgWinnerConfidence =
      winners.length > 0
        ? winners.reduce((sum, a) => sum + a.supervisorConfidence, 0) / winners.length
        : 0;
    const avgLoserConfidence =
      losers.length > 0
        ? losers.reduce((sum, a) => sum + a.supervisorConfidence, 0) / losers.length
        : 0;
    // Good calibration: winner confidence > loser confidence. Score 0-1.
    const confidenceCalibration =
      avgWinnerConfidence > avgLoserConfidence
        ? Math.min(1, avgWinnerConfidence - avgLoserConfidence)
        : 0;

    // Regime accuracy: % of trades where regime didn't mislead
    // Proxy: trades where edge was accurate in the given regime
    const regimeAccuracy = edgePredictionAccuracy; // simplified for now

    return {
      edgePredictionAccuracy: Math.round(edgePredictionAccuracy * 1000) / 1000,
      confidenceCalibration: Math.round(confidenceCalibration * 1000) / 1000,
      regimeAccuracy: Math.round(regimeAccuracy * 1000) / 1000,
    };
  }

  private computeRiskMetrics(
    riskDecisions: Array<{ approved: boolean; rejectionReasons: string[] }>,
    tradeCount: number,
  ): RiskMetrics {
    const totalEvaluations = riskDecisions.length;
    const rejections = riskDecisions.filter((d) => !d.approved);
    const rejectionRate =
      totalEvaluations > 0 ? rejections.length / totalEvaluations : 0;

    // Count rejection reasons
    const reasonCounts: Record<string, number> = {};
    for (const d of rejections) {
      for (const reason of d.rejectionReasons) {
        reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
      }
    }

    const topRejectionReasons = Object.entries(reasonCounts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .map(([reason]) => reason);

    return {
      rejectionRate: Math.round(rejectionRate * 1000) / 1000,
      topRejectionReasons,
    };
  }

  // ─── Private: HTTP Helpers ───────────────────────────────────────────────

  private async fetchJson<T>(url: string): Promise<T | null> {
    try {
      const response = await fetch(url, {
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) return null;
      return (await response.json()) as T;
    } catch {
      this.logger.warn(`Failed to fetch ${url}`);
      return null;
    }
  }
}
