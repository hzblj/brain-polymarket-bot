import { createDb } from '@brain/database';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrderbookService } from './orderbook.service';

describe('OrderbookService', () => {
  let service: OrderbookService;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    // Mock fetch so token discovery falls through to simulated mode
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no network in test')));
    const db = createDb(':memory:');
    service = new OrderbookService(db);
  });

  afterEach(() => {
    service.onModuleDestroy();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** Advance timers to trigger N snapshot intervals. */
  async function advanceSnapshots(count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
      await vi.advanceTimersByTimeAsync(1_000);
    }
  }

  // ---------------------------------------------------------------------------
  // getCurrentSnapshot()
  // ---------------------------------------------------------------------------

  describe('getCurrentSnapshot()', () => {
    it('should return null before any updates', async () => {
      const snapshot = await service.getCurrentSnapshot();
      expect(snapshot).toBeNull();
    });

    it('should return a snapshot after initialization and first interval', async () => {
      await service.onModuleInit();
      await advanceSnapshots(1);

      const snapshot = await service.getCurrentSnapshot();
      expect(snapshot).not.toBeNull();
      expect(snapshot?.up).toBeDefined();
      expect(snapshot?.down).toBeDefined();
      expect(snapshot?.timestamp).toBeDefined();
    });

    it('should have bids and asks for both sides', async () => {
      await service.onModuleInit();
      await advanceSnapshots(1);

      const snapshot = await service.getCurrentSnapshot();
      expect(snapshot?.up.bids.length).toBeGreaterThan(0);
      expect(snapshot?.up.asks.length).toBeGreaterThan(0);
      expect(snapshot?.down.bids.length).toBeGreaterThan(0);
      expect(snapshot?.down.asks.length).toBeGreaterThan(0);
    });

    it('should have correct OrderLevel shape', async () => {
      await service.onModuleInit();
      await advanceSnapshots(1);

      const snapshot = await service.getCurrentSnapshot();
      const level = snapshot?.up.bids[0];
      expect(typeof level.price).toBe('number');
      expect(typeof level.size).toBe('number');
      expect(typeof level.cumSize).toBe('number');
      expect(level.price).toBeGreaterThan(0);
      expect(level.size).toBeGreaterThan(0);
      expect(level.cumSize).toBeGreaterThanOrEqual(level.size);
    });

    it('should have monotonically increasing cumSize for bids', async () => {
      await service.onModuleInit();
      await advanceSnapshots(1);

      const snapshot = await service.getCurrentSnapshot();
      const bids = snapshot?.up.bids;
      for (let i = 1; i < bids.length; i++) {
        expect(bids[i]?.cumSize).toBeGreaterThanOrEqual(bids[i - 1]?.cumSize);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // getDepth()
  // ---------------------------------------------------------------------------

  describe('getDepth()', () => {
    it('should return empty when no snapshot', async () => {
      const depth = await service.getDepth({ levels: 5, side: 'up' });
      expect(depth.bids).toEqual([]);
      expect(depth.asks).toEqual([]);
      expect(depth.totalBidSize).toBe(0);
      expect(depth.totalAskSize).toBe(0);
      expect(depth.side).toBe('up');
    });

    it('should limit levels', async () => {
      await service.onModuleInit();
      await advanceSnapshots(1);

      const depth = await service.getDepth({ levels: 3, side: 'up' });
      expect(depth.bids.length).toBeLessThanOrEqual(3);
      expect(depth.asks.length).toBeLessThanOrEqual(3);
    });

    it('should return correct side data', async () => {
      await service.onModuleInit();
      await advanceSnapshots(1);

      const upDepth = await service.getDepth({ levels: 10, side: 'up' });
      const downDepth = await service.getDepth({ levels: 10, side: 'down' });

      expect(upDepth.side).toBe('up');
      expect(downDepth.side).toBe('down');
      // UP mid ~0.57, DOWN mid ~0.42, so UP bids should generally be higher
      expect(upDepth.bids[0]?.price).toBeGreaterThan(downDepth.bids[0]?.price);
    });

    it('should compute totalBidSize as sum of returned levels', async () => {
      await service.onModuleInit();
      await advanceSnapshots(1);

      const depth = await service.getDepth({ levels: 5, side: 'up' });
      const expectedSum = depth.bids.reduce((sum, l) => sum + l.size, 0);
      expect(depth.totalBidSize).toBeCloseTo(expectedSum, 1);
    });

    it('should compute totalAskSize as sum of returned levels', async () => {
      await service.onModuleInit();
      await advanceSnapshots(1);

      const depth = await service.getDepth({ levels: 5, side: 'down' });
      const expectedSum = depth.asks.reduce((sum, l) => sum + l.size, 0);
      expect(depth.totalAskSize).toBeCloseTo(expectedSum, 1);
    });

    it('should return fewer levels than requested when book is shallow', async () => {
      await service.onModuleInit();
      await advanceSnapshots(1);

      // Book has 10 levels, request 20
      const depth = await service.getDepth({ levels: 20, side: 'up' });
      expect(depth.bids.length).toBe(10);
      expect(depth.asks.length).toBe(10);
    });
  });

  // ---------------------------------------------------------------------------
  // getMetrics()
  // ---------------------------------------------------------------------------

  describe('getMetrics()', () => {
    it('should return null when no snapshot', async () => {
      const metrics = await service.getMetrics();
      expect(metrics).toBeNull();
    });

    it('should return metrics with correct shape', async () => {
      await service.onModuleInit();
      await advanceSnapshots(1);

      const metrics = await service.getMetrics();
      expect(metrics).not.toBeNull();
      expect(metrics?.up).toBeDefined();
      expect(metrics?.down).toBeDefined();
      expect(typeof metrics?.spreadBps).toBe('number');
      expect(typeof metrics?.imbalance).toBe('number');
      expect(typeof metrics?.microprice).toBe('number');
      expect(typeof metrics?.liquidityScore).toBe('number');
      expect(metrics?.timestamp).toBeDefined();
    });

    it('should compute spread as non-negative', async () => {
      await service.onModuleInit();
      await advanceSnapshots(1);

      const metrics = await service.getMetrics();
      expect(metrics?.spreadBps).toBeGreaterThanOrEqual(0);
      expect(metrics?.up.spread).toBeGreaterThanOrEqual(0);
      expect(metrics?.down.spread).toBeGreaterThanOrEqual(0);
    });

    it('should compute imbalance between -1 and 1', async () => {
      await service.onModuleInit();
      await advanceSnapshots(1);

      const metrics = await service.getMetrics();
      expect(metrics?.imbalance).toBeGreaterThanOrEqual(-1);
      expect(metrics?.imbalance).toBeLessThanOrEqual(1);
    });

    it('should compute microprice between best bid and ask of UP side', async () => {
      await service.onModuleInit();
      await advanceSnapshots(1);

      const metrics = await service.getMetrics();
      // Microprice should be between best bid and best ask of UP
      expect(metrics?.microprice).toBeGreaterThanOrEqual(metrics?.up.bestBid);
      expect(metrics?.microprice).toBeLessThanOrEqual(metrics?.up.bestAsk);
    });

    it('should compute liquidityScore between 0 and 1', async () => {
      await service.onModuleInit();
      await advanceSnapshots(1);

      const metrics = await service.getMetrics();
      expect(metrics?.liquidityScore).toBeGreaterThanOrEqual(0);
      expect(metrics?.liquidityScore).toBeLessThanOrEqual(1);
    });

    it('should have bestBid < bestAsk for each side', async () => {
      await service.onModuleInit();
      await advanceSnapshots(1);

      const metrics = await service.getMetrics();
      expect(metrics?.up.bestBid).toBeLessThan(metrics?.up.bestAsk);
      expect(metrics?.down.bestBid).toBeLessThan(metrics?.down.bestAsk);
    });

    it('should have positive depth on both sides', async () => {
      await service.onModuleInit();
      await advanceSnapshots(1);

      const metrics = await service.getMetrics();
      expect(metrics?.up.bidDepth).toBeGreaterThan(0);
      expect(metrics?.up.askDepth).toBeGreaterThan(0);
      expect(metrics?.down.bidDepth).toBeGreaterThan(0);
      expect(metrics?.down.askDepth).toBeGreaterThan(0);
    });
  });

  // ---------------------------------------------------------------------------
  // computeMetrics edge cases (via getMetrics)
  // ---------------------------------------------------------------------------

  describe('computeMetrics edge cases', () => {
    it('should compute spreadBps relative to mid price', async () => {
      await service.onModuleInit();
      await advanceSnapshots(1);

      const metrics = await service.getMetrics();
      // spreadBps = (spread / midPrice) * 10000
      const expectedMid = (metrics?.up.bestBid + metrics?.up.bestAsk) / 2;
      const expectedBps = Math.round((metrics?.up.spread / expectedMid) * 10_000 * 100) / 100;
      expect(metrics?.spreadBps).toBeCloseTo(expectedBps, 0);
    });

    it('should compute microprice as volume-weighted mid', async () => {
      await service.onModuleInit();
      await advanceSnapshots(1);

      const snapshot = await service.getCurrentSnapshot();
      const bestBid = snapshot?.up.bids[0];
      const bestAsk = snapshot?.up.asks[0];
      const totalSize = bestBid.size + bestAsk.size;
      const expectedMicroprice =
        (bestBid.price * bestAsk.size + bestAsk.price * bestBid.size) / totalSize;

      const metrics = await service.getMetrics();
      expect(metrics?.microprice).toBeCloseTo(expectedMicroprice, 4);
    });
  });

  // ---------------------------------------------------------------------------
  // getHistory()
  // ---------------------------------------------------------------------------

  describe('getHistory()', () => {
    it('should return empty when no snapshots', async () => {
      const result = await service.getHistory({
        from: '2026-03-20T00:00:00Z',
        to: '2026-03-20T23:59:59Z',
      });
      expect(result.snapshots).toEqual([]);
      expect(result.count).toBe(0);
    });

    it('should return snapshots within time range', async () => {
      vi.setSystemTime(new Date('2026-03-20T10:00:00.000Z'));
      await service.onModuleInit();
      await advanceSnapshots(5);

      const result = await service.getHistory({
        from: '2026-03-20T10:00:01.000Z',
        to: '2026-03-20T10:00:03.000Z',
      });

      expect(result.count).toBeGreaterThan(0);
      for (const snap of result.snapshots) {
        const snapMs = new Date(snap.timestamp).getTime();
        expect(snapMs).toBeGreaterThanOrEqual(new Date('2026-03-20T10:00:01.000Z').getTime());
        expect(snapMs).toBeLessThanOrEqual(new Date('2026-03-20T10:00:03.000Z').getTime());
      }
    });

    it('should cap history at buffer size (300)', async () => {
      vi.setSystemTime(new Date('2026-03-20T10:00:00.000Z'));
      await service.onModuleInit();
      await advanceSnapshots(310);

      const result = await service.getHistory({
        from: '2026-03-20T00:00:00Z',
        to: '2026-03-21T00:00:00Z',
      });

      expect(result.count).toBeLessThanOrEqual(300);
    });
  });

  // ---------------------------------------------------------------------------
  // Snapshot interval / lifecycle
  // ---------------------------------------------------------------------------

  describe('snapshot interval', () => {
    it('should produce snapshots at 1-second intervals', async () => {
      vi.setSystemTime(new Date('2026-03-20T10:00:00.000Z'));
      await service.onModuleInit();

      await advanceSnapshots(3);

      const result = await service.getHistory({
        from: '2026-03-20T09:59:00Z',
        to: '2026-03-20T10:01:00Z',
      });

      expect(result.count).toBe(3);
    });

    it('should stop producing snapshots after destroy', async () => {
      vi.setSystemTime(new Date('2026-03-20T10:00:00.000Z'));
      await service.onModuleInit();
      await advanceSnapshots(2);

      service.onModuleDestroy();

      const countBefore = (
        await service.getHistory({ from: '2026-03-20T00:00:00Z', to: '2026-03-21T00:00:00Z' })
      ).count;

      await advanceSnapshots(5);

      const countAfter = (
        await service.getHistory({ from: '2026-03-20T00:00:00Z', to: '2026-03-21T00:00:00Z' })
      ).count;

      expect(countAfter).toBe(countBefore);
    });
  });

  // ---------------------------------------------------------------------------
  // Generated book data properties
  // ---------------------------------------------------------------------------

  describe('generated book data', () => {
    it('should keep bid prices within (0.01, 0.99)', async () => {
      await service.onModuleInit();
      await advanceSnapshots(1);

      const snapshot = await service.getCurrentSnapshot();
      for (const level of snapshot?.up.bids ?? []) {
        expect(level.price).toBeGreaterThanOrEqual(0.01);
        expect(level.price).toBeLessThanOrEqual(0.99);
      }
      for (const level of snapshot?.down.asks ?? []) {
        expect(level.price).toBeGreaterThanOrEqual(0.01);
        expect(level.price).toBeLessThanOrEqual(0.99);
      }
    });

    it('should generate 10 levels per side', async () => {
      await service.onModuleInit();
      await advanceSnapshots(1);

      const snapshot = await service.getCurrentSnapshot();
      expect(snapshot?.up.bids.length).toBe(10);
      expect(snapshot?.up.asks.length).toBe(10);
      expect(snapshot?.down.bids.length).toBe(10);
      expect(snapshot?.down.asks.length).toBe(10);
    });
  });
});
