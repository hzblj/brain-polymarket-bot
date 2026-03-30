import {
  agentDecisions,
  DATABASE_CLIENT,
  type DbClient,
  featureSnapshots,
  marketWindows,
  replays as replaysTable,
  riskDecisions,
} from '@brain/database';
import type {
  AgentDecision,
  FeaturePayload,
  ReplayResults,
  RiskEvaluation,
  SupervisorOutput,
  UnixMs,
} from '@brain/types';
import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';

// ─── Request / Response Types ────────────────────────────────────────────────

export interface ReplayRunRequest {
  fromTime: UnixMs;
  toTime: UnixMs;
  reEvaluateAgents: boolean;
  speedMultiplier?: number;
}

export interface ReplayWindowRequest {
  windowId: string;
  reEvaluateAgents: boolean;
}

interface WindowReplayResult {
  windowId: string;
  originalDecision: AgentDecision | null;
  replayedDecision: AgentDecision | null;
  originalRisk: RiskEvaluation | null;
  replayedRisk: RiskEvaluation | null;
  decisionChanged: boolean;
  originalPnlUsd: number;
  replayedPnlUsd: number;
  features: FeaturePayload | null;
}

interface ReplayRun {
  id: string;
  fromTime: UnixMs;
  toTime: UnixMs;
  reEvaluateAgents: boolean;
  status: 'pending' | 'running' | 'completed' | 'failed';
  windowResults: WindowReplayResult[];
  results: ReplayResults | null;
  createdAt: string;
  completedAt: string | null;
  error: string | null;
}

interface ReplaySummary {
  totalReplays: number;
  totalWindowsReplayed: number;
  avgPnlUsd: number;
  avgWinRate: number;
  decisionsChanged: number;
  totalDecisions: number;
  bestReplayPnl: number;
  worstReplayPnl: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const WINDOW_DURATION_MS = 5 * 60 * 1000; // 5 minutes

@Injectable()
export class ReplayService {
  private replays: Map<string, ReplayRun> = new Map();

  constructor(@Inject(DATABASE_CLIENT) private readonly db: DbClient) {}

  // ─── Public API ──────────────────────────────────────────────────────────────

  /**
   * Starts a full replay over a time interval.
   * Loads all windows in the range, their features, and original decisions.
   * Optionally re-evaluates agents on historical features.
   */
  async runReplay(request: ReplayRunRequest): Promise<ReplayRun> {
    const { fromTime, toTime, reEvaluateAgents } = request;

    if (toTime <= fromTime) {
      throw new HttpException('toTime must be after fromTime', HttpStatus.BAD_REQUEST);
    }

    const replay: ReplayRun = {
      id: `replay-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      fromTime,
      toTime,
      reEvaluateAgents,
      status: 'running',
      windowResults: [],
      results: null,
      createdAt: new Date().toISOString(),
      completedAt: null,
      error: null,
    };

    this.replays.set(replay.id, replay);

    try {
      // Calculate all window boundaries in the range
      const windowStarts = this.getWindowBoundaries(fromTime, toTime);

      for (const windowStart of windowStarts) {
        const windowId = this.windowIdFromTimestamp(windowStart);
        const windowResult = await this.replayOneWindow(windowId, reEvaluateAgents);
        replay.windowResults.push(windowResult);
      }

      // Compute aggregate results
      replay.results = this.computeResults(replay.windowResults);
      replay.status = 'completed';
      replay.completedAt = new Date().toISOString();

      // Persist to database
      try {
        await this.db.insert(replaysTable).values({
          id: replay.id,
          fromTime: replay.fromTime,
          toTime: replay.toTime,
          config: { reEvaluateAgents: replay.reEvaluateAgents } as Record<string, unknown>,
          results: replay.results as unknown as Record<string, unknown>,
        });
      } catch {
        /* ignore */
      }

      this.emitEvent('replay.completed', {
        replayId: replay.id,
        totalWindows: replay.results.totalWindows,
        pnlUsd: replay.results.pnlUsd,
        winRate: replay.results.winRate,
      });
    } catch (error) {
      replay.status = 'failed';
      replay.error = (error as Error).message;
      replay.completedAt = new Date().toISOString();
    }

    return replay;
  }

  /**
   * Returns a single replay by ID.
   */
  async getReplay(replayId: string): Promise<ReplayRun> {
    const replay = this.replays.get(replayId);
    if (replay) return replay;

    // Fall back to database
    const [dbReplay] = await this.db
      .select()
      .from(replaysTable)
      .where(eq(replaysTable.id, replayId))
      .limit(1);
    if (dbReplay) {
      return {
        id: dbReplay.id,
        fromTime: dbReplay.fromTime,
        toTime: dbReplay.toTime,
        reEvaluateAgents: false,
        status: 'completed',
        windowResults: [],
        results: dbReplay.results as ReplayResults | null,
        createdAt: dbReplay.createdAt,
        completedAt: dbReplay.createdAt,
        error: null,
      };
    }

    throw new HttpException(`Replay ${replayId} not found`, HttpStatus.NOT_FOUND);
  }

  /**
   * Replays a single market window.
   */
  replayWindow(request: ReplayWindowRequest): Promise<WindowReplayResult> {
    return this.replayOneWindow(request.windowId, request.reEvaluateAgents);
  }

  /**
   * Returns aggregated statistics across all completed replays.
   */
  async getSummary(): Promise<ReplaySummary> {
    // Load from both in-memory and database
    let completedReplays = Array.from(this.replays.values()).filter(
      (r) => r.status === 'completed' && r.results,
    );

    // Also load from database if in-memory is empty
    if (completedReplays.length === 0) {
      try {
        const dbReplays = await this.db.select().from(replaysTable);
        const dbCompleted = dbReplays.filter((r) => r.results !== null);
        if (dbCompleted.length > 0) {
          completedReplays = dbCompleted.map((r) => ({
            id: r.id,
            fromTime: r.fromTime,
            toTime: r.toTime,
            reEvaluateAgents: false,
            status: 'completed' as const,
            windowResults: [],
            results: r.results as ReplayResults | null,
            createdAt: r.createdAt,
            completedAt: r.createdAt,
            error: null,
          }));
        }
      } catch {
        /* ignore */
      }
    }

    if (completedReplays.length === 0) {
      return {
        totalReplays: 0,
        totalWindowsReplayed: 0,
        avgPnlUsd: 0,
        avgWinRate: 0,
        decisionsChanged: 0,
        totalDecisions: 0,
        bestReplayPnl: 0,
        worstReplayPnl: 0,
      };
    }

    const pnls = completedReplays.map((r) => r.results?.pnlUsd ?? 0);
    const winRates = completedReplays.map((r) => r.results?.winRate ?? 0);
    const totalWindows = completedReplays.reduce(
      (sum, r) => sum + (r.results?.totalWindows ?? 0),
      0,
    );
    const decisionsChanged = completedReplays.reduce(
      (sum, r) => sum + r.windowResults.filter((w) => w.decisionChanged).length,
      0,
    );
    const totalDecisions = completedReplays.reduce((sum, r) => sum + r.windowResults.length, 0);

    return {
      totalReplays: completedReplays.length,
      totalWindowsReplayed: totalWindows,
      avgPnlUsd: pnls.reduce((a, b) => a + b, 0) / pnls.length,
      avgWinRate: winRates.reduce((a, b) => a + b, 0) / winRates.length,
      decisionsChanged,
      totalDecisions,
      bestReplayPnl: Math.max(...pnls),
      worstReplayPnl: Math.min(...pnls),
    };
  }

  // ─── Internal Helpers ──────────────────────────────────────────────────────

  private async replayOneWindow(
    windowId: string,
    reEvaluateAgents: boolean,
  ): Promise<WindowReplayResult> {
    // Load historical data for this window
    const features = await this.loadFeatures(windowId);
    const originalDecision = await this.loadOriginalDecision(windowId);
    const originalRisk = await this.loadOriginalRiskDecision(windowId);
    const originalPnl = await this.computeWindowPnl(windowId, originalDecision);

    let replayedDecision: AgentDecision | null = null;
    const replayedRisk: RiskEvaluation | null = null;
    let replayedPnl = 0;
    let decisionChanged = false;

    if (reEvaluateAgents && features) {
      // Re-run agent evaluation on historical features
      // TODO: Call agent-gateway-service to re-evaluate
      // const regimeResult = await httpClient.post('http://localhost:3008/api/v1/agent/regime/evaluate', { windowId, features });
      // const edgeResult = await httpClient.post('http://localhost:3008/api/v1/agent/edge/evaluate', { windowId, features });
      // const supervisorResult = await httpClient.post('http://localhost:3008/api/v1/agent/supervisor/evaluate', { ... });

      // Stub: simulate a re-evaluation result
      replayedDecision = this.simulateReplayedDecision(windowId, features);

      // Compare original vs replayed
      if (originalDecision && replayedDecision) {
        const origOutput = originalDecision.output as SupervisorOutput;
        const replayOutput = replayedDecision.output as SupervisorOutput;
        decisionChanged = origOutput.action !== replayOutput.action;
      }

      // Simulate P&L for the replayed decision
      replayedPnl = await this.computeWindowPnl(windowId, replayedDecision);
    }

    return {
      windowId,
      originalDecision,
      replayedDecision,
      originalRisk,
      replayedRisk,
      decisionChanged,
      originalPnlUsd: originalPnl,
      replayedPnlUsd: replayedPnl,
      features,
    };
  }

  private getWindowBoundaries(fromTime: UnixMs, toTime: UnixMs): UnixMs[] {
    const boundaries: UnixMs[] = [];
    let current = Math.ceil(fromTime / WINDOW_DURATION_MS) * WINDOW_DURATION_MS;

    while (current < toTime) {
      boundaries.push(current);
      current += WINDOW_DURATION_MS;
    }

    return boundaries;
  }

  private windowIdFromTimestamp(startMs: UnixMs): string {
    return `btc-5m-${new Date(startMs).toISOString().replace(/[:.]/g, '-')}`;
  }

  private async loadFeatures(windowId: string): Promise<FeaturePayload | null> {
    try {
      const rows = await this.db
        .select()
        .from(featureSnapshots)
        .where(eq(featureSnapshots.windowId, windowId))
        .orderBy(desc(featureSnapshots.processedAt))
        .limit(1);
      if (rows.length > 0) {
        return rows[0]?.payload as unknown as FeaturePayload;
      }
    } catch {
      /* ignore */
    }
    return null;
  }

  private async loadOriginalDecision(windowId: string): Promise<AgentDecision | null> {
    try {
      const [decision] = await this.db
        .select()
        .from(agentDecisions)
        .where(
          and(eq(agentDecisions.windowId, windowId), eq(agentDecisions.agentType, 'supervisor')),
        )
        .orderBy(desc(agentDecisions.processedAt))
        .limit(1);
      if (decision) {
        return {
          id: decision.id,
          windowId: decision.windowId,
          agentType: decision.agentType,
          input: decision.input as Record<string, unknown>,
          output: decision.output as SupervisorOutput,
          model: decision.model,
          provider: decision.provider,
          latencyMs: decision.latencyMs,
          eventTime: decision.eventTime,
          processedAt: decision.processedAt,
        };
      }
    } catch {
      /* ignore */
    }
    return null;
  }

  private async loadOriginalRiskDecision(windowId: string): Promise<RiskEvaluation | null> {
    try {
      const [decision] = await this.db
        .select()
        .from(riskDecisions)
        .where(eq(riskDecisions.windowId, windowId))
        .orderBy(desc(riskDecisions.processedAt))
        .limit(1);
      if (decision) {
        return {
          id: decision.id,
          windowId: decision.windowId,
          agentDecisionId: decision.agentDecisionId,
          approved: decision.approved,
          approvedSizeUsd: decision.approvedSizeUsd,
          rejectionReasons: decision.rejectionReasons as string[],
          eventTime: decision.eventTime,
          processedAt: decision.processedAt,
        };
      }
    } catch {
      /* ignore */
    }
    return null;
  }

  private async computeWindowPnl(
    windowId: string,
    decision: AgentDecision | null,
  ): Promise<number> {
    if (!decision) return 0;

    const output = decision.output as SupervisorOutput;
    if (output.action === 'hold') return 0;

    // Load actual outcome from database
    try {
      const [window] = await this.db
        .select()
        .from(marketWindows)
        .where(eq(marketWindows.id, windowId))
        .limit(1);
      if (window && window.outcome !== 'unknown') {
        const won =
          (output.action === 'buy_up' && window.outcome === 'up') ||
          (output.action === 'buy_down' && window.outcome === 'down');
        return won ? output.sizeUsd * 0.8 : -output.sizeUsd;
      }
    } catch {
      /* ignore */
    }

    // Stub: simulate random P&L for development
    const direction = output.action === 'buy_up' ? 1 : -1;
    const simulatedOutcome = Math.random() > 0.5 ? 1 : -1;
    const won = direction === simulatedOutcome;
    return won ? output.sizeUsd * 0.8 : -output.sizeUsd;
  }

  private simulateReplayedDecision(windowId: string, features: FeaturePayload): AgentDecision {
    // Stub: generate a simulated re-evaluation
    return {
      id: `replay-decision-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      windowId,
      agentType: 'supervisor',
      input: features as unknown as Record<string, unknown>,
      output: {
        action: 'hold',
        sizeUsd: 0,
        confidence: 0.45,
        reasoning: 'Replay evaluation: insufficient edge detected in historical data.',
        regimeSummary: 'Market was in a mean-reverting regime during this window.',
        edgeSummary: 'No significant edge detected in replay.',
      } satisfies SupervisorOutput,
      model: 'claude-sonnet-4-20250514',
      provider: 'anthropic',
      latencyMs: 0,
      eventTime: features.eventTime,
      processedAt: Date.now(),
    };
  }

  private computeResults(windowResults: WindowReplayResult[]): ReplayResults {
    const trades = windowResults.filter((w) => w.replayedPnlUsd !== 0);
    const wins = trades.filter((w) => w.replayedPnlUsd > 0);
    const totalPnl = windowResults.reduce((sum, w) => sum + w.replayedPnlUsd, 0);

    return {
      totalWindows: windowResults.length,
      totalTrades: trades.length,
      pnlUsd: totalPnl,
      winRate: trades.length > 0 ? wins.length / trades.length : 0,
      avgLatencyMs: 0,
    };
  }

  private emitEvent(_event: string, _payload: Record<string, unknown>): void {
    /* noop */
  }
}
