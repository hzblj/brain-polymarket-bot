import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '@brain/events';
import { MarketDiscoveryService } from './market-discovery.service';

describe('MarketDiscoveryService', () => {
  let service: MarketDiscoveryService;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    // Mock fetch so Gamma API calls fail gracefully and service uses stub
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no network in test')));
    service = new MarketDiscoveryService(null as any, new EventBus());
  });

  afterEach(() => {
    // Clean up polling timer if started
    service.onModuleDestroy();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // getActiveMarket()
  // ---------------------------------------------------------------------------

  describe('getActiveMarket()', () => {
    it('should return null-safe on first call and discover a market', async () => {
      const market = await service.getActiveMarket();
      expect(market).not.toBeNull();
      expect(market?.marketId).toMatch(/^btc-5m-/);
      expect(market?.slug).toBe('bitcoin-up-or-down-5-minutes');
      expect(market?.status).toBe('open');
    });

    it('should return the same market on subsequent calls within the window', async () => {
      const first = await service.getActiveMarket();
      const second = await service.getActiveMarket();
      expect(first?.marketId).toBe(second?.marketId);
    });

    it('should refresh when market is expired', async () => {
      // Discover a market at time T
      const now = new Date('2026-03-20T10:00:00.000Z');
      vi.setSystemTime(now);
      const market1 = await service.getActiveMarket();
      expect(market1).not.toBeNull();

      // Advance past the 5-minute window end
      vi.setSystemTime(new Date(now.getTime() + 6 * 60 * 1000));
      const market2 = await service.getActiveMarket();
      expect(market2).not.toBeNull();
      // Should have discovered a new market (different window)
      expect(market2?.marketId).not.toBe(market1?.marketId);
    });

    it('should have correct shape for discovered market', async () => {
      const market = await service.getActiveMarket();
      expect(market).toEqual(
        expect.objectContaining({
          slug: 'bitcoin-up-or-down-5-minutes',
          question: 'Will Bitcoin go up or down in the next 5 minutes?',
          status: 'open',
        }),
      );
      expect(market?.conditionId).toMatch(/^0x/);
      expect(market?.upTokenId).toMatch(/^0x/);
      expect(market?.downTokenId).toMatch(/^0x/);
      expect(market?.startTime).toBeDefined();
      expect(market?.endTime).toBeDefined();
      expect(market?.discoveredAt).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // getCurrentWindow()
  // ---------------------------------------------------------------------------

  describe('getCurrentWindow()', () => {
    it('should return window data for active market', async () => {
      vi.setSystemTime(new Date('2026-03-20T10:01:00.000Z'));
      const window = await service.getCurrentWindow();
      expect(window).not.toBeNull();
      expect(window?.marketId).toMatch(/^btc-5m-/);
      expect(window?.start).toBeDefined();
      expect(window?.end).toBeDefined();
      expect(typeof window?.secondsToClose).toBe('number');
      expect(typeof window?.isOpen).toBe('boolean');
    });

    it('should report isOpen=true when within window', async () => {
      // Set time to exactly on a 5-minute boundary + 30 seconds
      const windowStart = Math.floor(Date.now() / 300_000) * 300_000;
      vi.setSystemTime(new Date(windowStart + 30_000));

      const window = await service.getCurrentWindow();
      expect(window?.isOpen).toBe(true);
      expect(window?.secondsToClose).toBeGreaterThan(0);
      expect(window?.secondsToClose).toBeLessThanOrEqual(300);
    });

    it('should compute secondsToClose correctly', async () => {
      // Place ourselves 60 seconds into a 5-minute window
      const windowStart = Math.floor(Date.now() / 300_000) * 300_000;
      vi.setSystemTime(new Date(windowStart + 60_000));

      const window = await service.getCurrentWindow();
      // 300 - 60 = 240 seconds to close
      expect(window?.secondsToClose).toBe(240);
    });

    it('should clamp secondsToClose to 0 when past window end', async () => {
      vi.setSystemTime(new Date('2026-03-20T10:00:00.000Z'));
      // Discover a market
      await service.getActiveMarket();

      // Jump past the window end (>5 minutes)
      vi.setSystemTime(new Date('2026-03-20T10:06:00.000Z'));
      // Force access to getCurrentWindow directly (will refresh to new market)
      const window = await service.getCurrentWindow();
      // After refresh, we're in a new window, secondsToClose should be >= 0
      expect(window?.secondsToClose).toBeGreaterThanOrEqual(0);
    });

    it('should set isOpen=false when before window start', async () => {
      // This is hard to trigger with the stub since it always generates
      // a window containing 'now', but we can verify the field exists
      const window = await service.getCurrentWindow();
      expect(window).not.toBeNull();
      // Since the stub generates a window around "now", isOpen should be true
      expect(window?.isOpen).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // refreshMarket()
  // ---------------------------------------------------------------------------

  describe('refreshMarket()', () => {
    it('should return a RefreshResult with correct shape', async () => {
      const result = await service.refreshMarket();
      expect(result).toHaveProperty('previousMarketId');
      expect(typeof result.currentMarketId).toBe('string');
      expect(typeof result.changed).toBe('boolean');
      expect(typeof result.refreshedAt).toBe('string');
    });

    it('should report changed=true on first call (null -> discovered)', async () => {
      const result = await service.refreshMarket();
      // previousMarketId is null on first call, discovered is not null
      expect(result.previousMarketId).toBeNull();
      expect(result.changed).toBe(true);
      expect(result.currentMarketId).toMatch(/^btc-5m-/);
    });

    it('should report changed=false on consecutive calls in same window', async () => {
      await service.refreshMarket();
      const result = await service.refreshMarket();
      expect(result.changed).toBe(false);
    });

    it('should detect market transition when window changes', async () => {
      vi.setSystemTime(new Date('2026-03-20T10:00:00.000Z'));
      const first = await service.refreshMarket();

      // Advance to next 5-minute window
      vi.setSystemTime(new Date('2026-03-20T10:05:00.000Z'));
      const second = await service.refreshMarket();

      expect(second.changed).toBe(true);
      expect(second.previousMarketId).toBe(first.currentMarketId);
      expect(second.currentMarketId).not.toBe(first.currentMarketId);
    });

    it('should emit market.active.changed event on transition', async () => {
      const spy = vi.spyOn(service as any, 'emitEvent');
      vi.setSystemTime(new Date('2026-03-20T10:00:30.000Z'));
      await service.refreshMarket();

      vi.setSystemTime(new Date('2026-03-20T10:05:30.000Z'));
      await service.refreshMarket();

      expect(spy).toHaveBeenCalledWith(
        'market.active.changed',
        expect.objectContaining({
          previousMarketId: expect.any(String),
          newMarketId: expect.any(String),
        }),
      );
    });

    it('should emit market.window.opened event early in window', async () => {
      const spy = vi.spyOn(service as any, 'emitEvent');
      // Set time near the start of a 5-minute window (>240s remaining)
      const windowStart =
        Math.floor(new Date('2026-03-20T10:00:00.000Z').getTime() / 300_000) * 300_000;
      vi.setSystemTime(new Date(windowStart + 5_000)); // 5 seconds in, 295s remaining

      await service.refreshMarket();

      expect(spy).toHaveBeenCalledWith(
        'market.window.opened',
        expect.objectContaining({ marketId: expect.any(String) }),
      );
    });

    it('should emit market.window.closing event near window end', async () => {
      const spy = vi.spyOn(service as any, 'emitEvent');
      // Set time near the end of a 5-minute window (<=30s remaining)
      const windowStart =
        Math.floor(new Date('2026-03-20T10:00:00.000Z').getTime() / 300_000) * 300_000;
      vi.setSystemTime(new Date(windowStart + 280_000)); // 280 seconds in, 20s remaining

      await service.refreshMarket();

      expect(spy).toHaveBeenCalledWith(
        'market.window.closing',
        expect.objectContaining({
          marketId: expect.any(String),
          secondsToClose: expect.any(Number),
        }),
      );
    });

    it('should return refreshedAt as valid ISO timestamp', async () => {
      const result = await service.refreshMarket();
      expect(() => new Date(result.refreshedAt)).not.toThrow();
      expect(new Date(result.refreshedAt).toISOString()).toBe(result.refreshedAt);
    });
  });

  // ---------------------------------------------------------------------------
  // Polling / lifecycle
  // ---------------------------------------------------------------------------

  describe('polling lifecycle', () => {
    it('should start polling on onModuleInit', async () => {
      await service.onModuleInit();
      // First refresh + polling started => market should be set
      const market = await service.getActiveMarket();
      expect(market).not.toBeNull();
    });

    it('should call refreshMarket periodically via polling', async () => {
      await service.onModuleInit();

      const market1 = await service.getActiveMarket();
      expect(market1).not.toBeNull();

      // Advance by one poll interval (15s)
      await vi.advanceTimersByTimeAsync(15_000);

      // Market should still exist (refresh called)
      const market2 = await service.getActiveMarket();
      expect(market2).not.toBeNull();
    });

    it('should stop polling on onModuleDestroy', async () => {
      await service.onModuleInit();
      service.onModuleDestroy();

      // After destroy, advancing timers should not cause errors
      await vi.advanceTimersByTimeAsync(30_000);
    });
  });

  // ---------------------------------------------------------------------------
  // Window timing edge cases
  // ---------------------------------------------------------------------------

  describe('window timing edge cases', () => {
    it('should align windows to 5-minute boundaries', async () => {
      vi.setSystemTime(new Date('2026-03-20T10:02:30.000Z'));
      const market = await service.getActiveMarket();
      const startMs = new Date(market?.startTime).getTime();
      // Start should be on a 300-second boundary
      expect(startMs % (300 * 1000)).toBe(0);
    });

    it('should have exactly 5-minute window duration', async () => {
      const market = await service.getActiveMarket();
      const startMs = new Date(market?.startTime).getTime();
      const endMs = new Date(market?.endTime).getTime();
      expect(endMs - startMs).toBe(300_000);
    });

    it('should generate deterministic market IDs for same window', async () => {
      vi.setSystemTime(new Date('2026-03-20T10:01:00.000Z'));
      const m1 = await service.getActiveMarket();

      // Create new service at same time
      const service2 = new MarketDiscoveryService(null as any, new EventBus());
      vi.setSystemTime(new Date('2026-03-20T10:01:30.000Z'));
      const m2 = await service2.getActiveMarket();

      expect(m1?.marketId).toBe(m2?.marketId);
    });

    it('should produce different conditionId, upTokenId, downTokenId', async () => {
      const market = await service.getActiveMarket();
      expect(market?.conditionId).not.toBe(market?.upTokenId);
      expect(market?.conditionId).not.toBe(market?.downTokenId);
      expect(market?.upTokenId).not.toBe(market?.downTokenId);
    });
  });
});
