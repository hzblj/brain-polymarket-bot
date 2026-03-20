import { Injectable, HttpException, HttpStatus } from '@nestjs/common';
import type {
  UnixMs,
  FeaturePayload,
  AgentDecision,
  RiskEvaluation,
  ReplayResults,
  SupervisorOutput,
  RegimeOutput,
  EdgeOutput,
} from '@brain/types';

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

  // TODO: inject @brain/database, @brain/events, @brain/logger
  // constructor(
  //   private readonly database: DatabaseService,
  //   private readonly events: EventsService,
  //   private readonly logger: LoggerService,
  // ) {}

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
      console.log(`[replay-service] Starting replay ${replay.id}: ${windowStarts.length} windows from ${new Date(fromTime).toISOString()} to ${new Date(toTime).toISOString()}`);

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
      // await this.database.replays.upsert(replay);

      this.emitEvent('replay.completed', {
        replayId: replay.id,
        totalWindows: replay.results.totalWindows,
        pnlUsd: replay.results.pnlUsd,
        winRate: replay.results.winRate,
      });

      console.log(`[replay-service] Replay ${replay.id} completed: P&L $${replay.results.pnlUsd.toFixed(2)}, win rate ${(replay.results.winRate * 100).toFixed(1)}%`);
    } catch (error) {
      replay.status = 'failed';
      replay.error = (error as Error).message;
      replay.completedAt = new Date().toISOString();
      console.error(`[replay-service] Replay ${replay.id} failed:`, error);
    }

    return replay;
  }

  /**
   * Returns a single replay by ID.
   */
  async getReplay(replayId: string): Promise<ReplayRun> {
    const replay = this.replays.get(replayId);
    if (!replay) {
      // TODO: Fall back to database
      // const dbReplay = await this.database.replays.findById(replayId);
      throw new HttpException(`Replay ${replayId} not found`, HttpStatus.NOT_FOUND);
    }
    return replay;
  }

  /**
   * Replays a single market window.
   */
  async replayWindow(request: ReplayWindowRequest): Promise<WindowReplayResult> {
    return this.replayOneWindow(request.windowId, request.reEvaluateAgents);
  }

  /**
   * Returns aggregated statistics across all completed replays.
   */
  async getSummary(): Promise<ReplaySummary> {
    // TODO: Load from database
    // const replays = await this.database.replays.findCompleted();

    const completedReplays = Array.from(this.replays.values()).filter(
      (r) => r.status === 'completed' && r.results,
    );

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

    const pnls = completedReplays.map((r) => r.results!.pnlUsd);
    const winRates = completedReplays.map((r) => r.results!.winRate);
    const totalWindows = completedReplays.reduce((sum, r) => sum + r.results!.totalWindows, 0);
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
    let replayedRisk: RiskEvaluation | null = null;
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
    // TODO: Load from database
    // return this.database.featureSnapshots.findByWindowId(windowId);

    // Stub: return null (no historical data in dev mode)
    console.log(`[replay-service] Loading features for window ${windowId} (stub)`);
    return null;
  }

  private async loadOriginalDecision(windowId: string): Promise<AgentDecision | null> {
    // TODO: Load from database
    // return this.database.agentDecisions.findByWindowIdAndType(windowId, 'supervisor');
    return null;
  }

  private async loadOriginalRiskDecision(windowId: string): Promise<RiskEvaluation | null> {
    // TODO: Load from database
    // return this.database.riskEvaluations.findByWindowId(windowId);
    return null;
  }

  private async computeWindowPnl(windowId: string, decision: AgentDecision | null): Promise<number> {
    if (!decision) return 0;

    const output = decision.output as SupervisorOutput;
    if (output.action === 'hold') return 0;

    // TODO: Load actual outcome from database
    // const window = await this.database.marketWindows.findById(windowId);
    // const outcome = window?.outcome;
    // Compute P&L based on entry price and outcome

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

  private emitEvent(event: string, payload: Record<string, unknown>): void {
    // TODO: Wire to @brain/events
    console.log(`[replay-service] event: ${event}`, JSON.stringify(payload));
  }
}
