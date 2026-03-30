import { createDb } from '@brain/database';
import { HttpException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReplayService } from './replay.service';

// ─── Constants ────────────────────────────────────────────────────────────────

const WINDOW_DURATION_MS = 5 * 60 * 1000; // 5 minutes

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ReplayService', () => {
  let service: ReplayService;

  beforeEach(() => {
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
    service = new ReplayService(db);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─── runReplay ─────────────────────────────────────────────────────────────

  describe('runReplay', () => {
    it('creates a replay run with a generated ID', async () => {
      const fromTime = 1700000000000;
      const toTime = fromTime + WINDOW_DURATION_MS * 3;

      const replay = await service.runReplay({
        fromTime,
        toTime,
        reEvaluateAgents: false,
      });

      expect(replay.id).toMatch(/^replay-/);
      expect(replay.fromTime).toBe(fromTime);
      expect(replay.toTime).toBe(toTime);
    });

    it('sets status to completed on success', async () => {
      const fromTime = 1700000000000;
      const toTime = fromTime + WINDOW_DURATION_MS * 2;

      const replay = await service.runReplay({
        fromTime,
        toTime,
        reEvaluateAgents: false,
      });

      expect(replay.status).toBe('completed');
      expect(replay.completedAt).not.toBeNull();
      expect(replay.error).toBeNull();
    });

    it('records createdAt as valid ISO timestamp', async () => {
      const fromTime = 1700000000000;
      const toTime = fromTime + WINDOW_DURATION_MS;

      const replay = await service.runReplay({
        fromTime,
        toTime,
        reEvaluateAgents: false,
      });

      const date = new Date(replay.createdAt);
      expect(date.toISOString()).toBe(replay.createdAt);
    });

    it('throws when toTime <= fromTime', async () => {
      await expect(
        service.runReplay({ fromTime: 1000, toTime: 1000, reEvaluateAgents: false }),
      ).rejects.toThrow(HttpException);

      await expect(
        service.runReplay({ fromTime: 2000, toTime: 1000, reEvaluateAgents: false }),
      ).rejects.toThrow('toTime must be after fromTime');
    });

    it('computes correct number of window boundaries', async () => {
      // Align fromTime to a window boundary for deterministic count
      const alignedFrom = Math.ceil(1700000000000 / WINDOW_DURATION_MS) * WINDOW_DURATION_MS;
      const toTime = alignedFrom + WINDOW_DURATION_MS * 4;

      const replay = await service.runReplay({
        fromTime: alignedFrom,
        toTime,
        reEvaluateAgents: false,
      });

      // 4 windows: alignedFrom, +5m, +10m, +15m (all < toTime)
      expect(replay.windowResults.length).toBe(4);
    });

    it('produces results with aggregate statistics', async () => {
      const fromTime = 1700000000000;
      const toTime = fromTime + WINDOW_DURATION_MS * 2;

      const replay = await service.runReplay({
        fromTime,
        toTime,
        reEvaluateAgents: false,
      });

      expect(replay.results).not.toBeNull();
      expect(replay.results?.totalWindows).toBeGreaterThanOrEqual(0);
      expect(typeof replay.results?.pnlUsd).toBe('number');
      expect(typeof replay.results?.winRate).toBe('number');
      expect(typeof replay.results?.totalTrades).toBe('number');
    });

    it('processes replay without re-evaluation — all decisions null', async () => {
      const fromTime = 1700000000000;
      const toTime = fromTime + WINDOW_DURATION_MS;

      const replay = await service.runReplay({
        fromTime,
        toTime,
        reEvaluateAgents: false,
      });

      // Without re-evaluation, replayed decisions are null (stubs return null features)
      for (const wr of replay.windowResults) {
        expect(wr.replayedDecision).toBeNull();
        expect(wr.decisionChanged).toBe(false);
      }
    });

    it('with reEvaluateAgents=true but null features, does not produce replayed decisions', async () => {
      // The stub loadFeatures returns null, so reEvaluateAgents branch won't execute
      const fromTime = 1700000000000;
      const toTime = fromTime + WINDOW_DURATION_MS;

      const replay = await service.runReplay({
        fromTime,
        toTime,
        reEvaluateAgents: true,
      });

      for (const wr of replay.windowResults) {
        // features is null from stub, so the if(reEvaluateAgents && features) block is skipped
        expect(wr.replayedDecision).toBeNull();
      }
    });

    it('handles zero-window range (fromTime already past next boundary)', async () => {
      // If fromTime and toTime are within the same window, no boundaries are generated
      const alignedFrom = Math.ceil(1700000000000 / WINDOW_DURATION_MS) * WINDOW_DURATION_MS;
      const toTime = alignedFrom; // equals first boundary, loop condition current < toTime fails

      const replay = await service.runReplay({
        fromTime: alignedFrom - 1000,
        toTime,
        reEvaluateAgents: false,
      });

      expect(replay.windowResults.length).toBe(0);
      expect(replay.results).not.toBeNull();
      expect(replay.results?.totalWindows).toBe(0);
    });
  });

  // ─── getReplay ─────────────────────────────────────────────────────────────

  describe('getReplay', () => {
    it('retrieves a replay by ID after creation', async () => {
      const fromTime = 1700000000000;
      const toTime = fromTime + WINDOW_DURATION_MS;

      const created = await service.runReplay({ fromTime, toTime, reEvaluateAgents: false });
      const retrieved = await service.getReplay(created.id);

      expect(retrieved.id).toBe(created.id);
      expect(retrieved.status).toBe('completed');
    });

    it('throws HttpException for unknown replay ID', async () => {
      await expect(service.getReplay('nonexistent-replay')).rejects.toThrow(HttpException);
      await expect(service.getReplay('nonexistent-replay')).rejects.toThrow('not found');
    });

    it('returns the full replay object with windowResults', async () => {
      const fromTime = 1700000000000;
      const toTime = fromTime + WINDOW_DURATION_MS * 2;

      const created = await service.runReplay({ fromTime, toTime, reEvaluateAgents: false });
      const retrieved = await service.getReplay(created.id);

      expect(Array.isArray(retrieved.windowResults)).toBe(true);
      expect(retrieved.results).not.toBeNull();
    });
  });

  // ─── replayWindow ─────────────────────────────────────────────────────────

  describe('replayWindow', () => {
    it('returns a WindowReplayResult for a single window', async () => {
      const result = await service.replayWindow({
        windowId: 'btc-5m-test-window',
        reEvaluateAgents: false,
      });

      expect(result).toBeDefined();
      expect(result.windowId).toBe('btc-5m-test-window');
    });

    it('window result has expected shape', async () => {
      const result = await service.replayWindow({
        windowId: 'btc-5m-shape-test',
        reEvaluateAgents: false,
      });

      expect(result).toHaveProperty('windowId');
      expect(result).toHaveProperty('originalDecision');
      expect(result).toHaveProperty('replayedDecision');
      expect(result).toHaveProperty('originalRisk');
      expect(result).toHaveProperty('replayedRisk');
      expect(result).toHaveProperty('decisionChanged');
      expect(result).toHaveProperty('originalPnlUsd');
      expect(result).toHaveProperty('replayedPnlUsd');
      expect(result).toHaveProperty('features');
    });

    it('with reEvaluateAgents=false, replayed fields are null/default', async () => {
      const result = await service.replayWindow({
        windowId: 'btc-5m-no-eval',
        reEvaluateAgents: false,
      });

      expect(result.replayedDecision).toBeNull();
      expect(result.replayedRisk).toBeNull();
      expect(result.replayedPnlUsd).toBe(0);
      expect(result.decisionChanged).toBe(false);
    });

    it('originalPnlUsd is 0 when no original decision exists (stub)', async () => {
      const result = await service.replayWindow({
        windowId: 'btc-5m-no-orig',
        reEvaluateAgents: false,
      });

      // Stub returns null for original decision, so PnL is 0
      expect(result.originalPnlUsd).toBe(0);
    });
  });

  // ─── getSummary ────────────────────────────────────────────────────────────

  describe('getSummary', () => {
    it('returns zero-value summary when no replays exist', async () => {
      const summary = await service.getSummary();

      expect(summary.totalReplays).toBe(0);
      expect(summary.totalWindowsReplayed).toBe(0);
      expect(summary.avgPnlUsd).toBe(0);
      expect(summary.avgWinRate).toBe(0);
      expect(summary.decisionsChanged).toBe(0);
      expect(summary.totalDecisions).toBe(0);
      expect(summary.bestReplayPnl).toBe(0);
      expect(summary.worstReplayPnl).toBe(0);
    });

    it('aggregates results from completed replays', async () => {
      const fromTime = 1700000000000;
      const toTime = fromTime + WINDOW_DURATION_MS * 2;

      await service.runReplay({ fromTime, toTime, reEvaluateAgents: false });
      await service.runReplay({ fromTime, toTime, reEvaluateAgents: false });

      const summary = await service.getSummary();

      expect(summary.totalReplays).toBe(2);
      expect(summary.totalWindowsReplayed).toBeGreaterThanOrEqual(0);
      expect(typeof summary.avgPnlUsd).toBe('number');
      expect(typeof summary.avgWinRate).toBe('number');
    });

    it('excludes failed replays from summary', async () => {
      // Run a valid replay
      const fromTime = 1700000000000;
      const toTime = fromTime + WINDOW_DURATION_MS;
      await service.runReplay({ fromTime, toTime, reEvaluateAgents: false });

      // Try an invalid replay that throws (toTime <= fromTime)
      try {
        await service.runReplay({ fromTime: 2000, toTime: 1000, reEvaluateAgents: false });
      } catch {
        // expected
      }

      const summary = await service.getSummary();
      // Only the valid replay should be counted
      expect(summary.totalReplays).toBe(1);
    });

    it('computes bestReplayPnl and worstReplayPnl', async () => {
      const fromTime = 1700000000000;
      const toTime1 = fromTime + WINDOW_DURATION_MS;
      const toTime2 = fromTime + WINDOW_DURATION_MS * 3;

      await service.runReplay({ fromTime, toTime: toTime1, reEvaluateAgents: false });
      await service.runReplay({ fromTime, toTime: toTime2, reEvaluateAgents: false });

      const summary = await service.getSummary();

      expect(summary.bestReplayPnl).toBeGreaterThanOrEqual(summary.worstReplayPnl);
    });

    it('summary has all expected fields', async () => {
      const summary = await service.getSummary();

      expect(summary).toHaveProperty('totalReplays');
      expect(summary).toHaveProperty('totalWindowsReplayed');
      expect(summary).toHaveProperty('avgPnlUsd');
      expect(summary).toHaveProperty('avgWinRate');
      expect(summary).toHaveProperty('decisionsChanged');
      expect(summary).toHaveProperty('totalDecisions');
      expect(summary).toHaveProperty('bestReplayPnl');
      expect(summary).toHaveProperty('worstReplayPnl');
    });
  });

  // ─── P&L simulation ────────────────────────────────────────────────────────

  describe('P&L computation', () => {
    it('computeResults returns 0 PnL when no trades', async () => {
      const fromTime = 1700000000000;
      const toTime = fromTime + WINDOW_DURATION_MS;

      const replay = await service.runReplay({ fromTime, toTime, reEvaluateAgents: false });

      // Stubs return null decisions, so all PnL should be 0
      expect(replay.results?.pnlUsd).toBe(0);
      expect(replay.results?.totalTrades).toBe(0);
    });

    it('winRate is 0 when no trades exist', async () => {
      const fromTime = 1700000000000;
      const toTime = fromTime + WINDOW_DURATION_MS;

      const replay = await service.runReplay({ fromTime, toTime, reEvaluateAgents: false });

      expect(replay.results?.winRate).toBe(0);
    });
  });

  // ─── Window ID generation ──────────────────────────────────────────────────

  describe('window boundaries', () => {
    it('windowResults have IDs matching btc-5m- prefix', async () => {
      const alignedFrom = Math.ceil(1700000000000 / WINDOW_DURATION_MS) * WINDOW_DURATION_MS;
      const toTime = alignedFrom + WINDOW_DURATION_MS * 2;

      const replay = await service.runReplay({
        fromTime: alignedFrom,
        toTime,
        reEvaluateAgents: false,
      });

      for (const wr of replay.windowResults) {
        expect(wr.windowId).toMatch(/^btc-5m-/);
      }
    });

    it('window IDs contain ISO-like timestamp', async () => {
      const alignedFrom = Math.ceil(1700000000000 / WINDOW_DURATION_MS) * WINDOW_DURATION_MS;
      const toTime = alignedFrom + WINDOW_DURATION_MS;

      const replay = await service.runReplay({
        fromTime: alignedFrom,
        toTime,
        reEvaluateAgents: false,
      });

      expect(replay.windowResults.length).toBe(1);
      // Window IDs replace : and . with - in the ISO string
      const windowId = replay.windowResults[0]?.windowId;
      expect(windowId).toContain('T');
      expect(windowId).not.toContain(':');
      expect(windowId).not.toContain('.');
    });
  });

  // ─── Multiple replays isolation ────────────────────────────────────────────

  describe('replay isolation', () => {
    it('each replay run gets a unique ID', async () => {
      const fromTime = 1700000000000;
      const toTime = fromTime + WINDOW_DURATION_MS;

      const r1 = await service.runReplay({ fromTime, toTime, reEvaluateAgents: false });
      const r2 = await service.runReplay({ fromTime, toTime, reEvaluateAgents: false });

      expect(r1.id).not.toBe(r2.id);
    });

    it('replays are stored independently and retrievable', async () => {
      const fromTime = 1700000000000;
      const toTime = fromTime + WINDOW_DURATION_MS;

      const r1 = await service.runReplay({ fromTime, toTime, reEvaluateAgents: false });
      const r2 = await service.runReplay({ fromTime, toTime, reEvaluateAgents: false });

      const fetched1 = await service.getReplay(r1.id);
      const fetched2 = await service.getReplay(r2.id);

      expect(fetched1.id).toBe(r1.id);
      expect(fetched2.id).toBe(r2.id);
    });
  });
});
