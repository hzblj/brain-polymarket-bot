import { createDb } from '@brain/database';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PriceFeedService, type BinanceBookTickerMessage } from './price-feed.service';

function makeTick(bid: number, ask: number, eventTime = Date.now()): BinanceBookTickerMessage {
  return { e: 'bookTicker', E: eventTime, s: 'BTCUSDT', b: String(bid), B: '1', a: String(ask), A: '1' };
}

describe('PriceFeedService', () => {
  let service: PriceFeedService;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const db = createDb(':memory:');
    service = new PriceFeedService(db);
    // Don't call onModuleInit — it tries to open real WS. Use handleBookTicker directly.
    service.resetWindow();
  });

  afterEach(() => {
    service.onModuleDestroy();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function feedTicks(count: number, basePrice = 84250): void {
    for (let i = 0; i < count; i++) {
      vi.advanceTimersByTime(1_000);
      const price = basePrice + i * 0.5;
      service.handleBookTicker(makeTick(price - 0.1, price + 0.1));
    }
  }

  // ── getCurrentPrice() ─────────────────────────────────────────────────

  describe('getCurrentPrice()', () => {
    it('returns default payload when no ticks collected', () => {
      const payload = service.getCurrentPrice();
      expect(payload.resolver.price).toBe(0);
      expect(payload.external.price).toBe(0);
      expect(payload.micro.return1s).toBe(0);
      expect(payload.micro.momentumScore).toBe(0.5);
    });

    it('populates resolver and external after ticks', () => {
      feedTicks(3);
      const payload = service.getCurrentPrice();
      expect(payload.resolver.price).toBeGreaterThan(0);
      expect(payload.external.price).toBeGreaterThan(0);
      expect(payload.external.bid).toBeGreaterThan(0);
      expect(payload.external.ask).toBeGreaterThan(0);
      expect(payload.external.ask).toBeGreaterThan(payload.external.bid);
    });

    it('uses Binance mid-price as resolver proxy', () => {
      service.handleBookTicker(makeTick(84250, 84252));
      const payload = service.getCurrentPrice();
      expect(payload.resolver.price).toBe(84251);
      expect(payload.external.bid).toBe(84250);
      expect(payload.external.ask).toBe(84252);
    });
  });

  // ── getWindowData() ───────────────────────────────────────────────────

  describe('getWindowData()', () => {
    it('returns initial window data with zero deltas', () => {
      const window = service.getWindowData();
      expect(window.startPrice).toBe(0);
      expect(window.deltaAbs).toBe(0);
      expect(window.timeToCloseSec).toBeLessThanOrEqual(300);
    });

    it('counts down timeToCloseSec over time', () => {
      service.resetWindow();
      const w1 = service.getWindowData();
      vi.advanceTimersByTime(10_000);
      const w2 = service.getWindowData();
      expect(w1.timeToCloseSec - w2.timeToCloseSec).toBe(10);
    });

    it('clamps timeToCloseSec at 0', () => {
      service.resetWindow();
      vi.advanceTimersByTime(400_000);
      expect(service.getWindowData().timeToCloseSec).toBe(0);
    });

    it('computes deltas after ticks', () => {
      service.handleBookTicker(makeTick(84250, 84252)); // sets resolver price
      service.resetWindow(); // lock start price at 84251
      vi.advanceTimersByTime(1000);
      service.handleBookTicker(makeTick(84260, 84262)); // new price 84261
      const window = service.getWindowData();
      expect(window.deltaAbs).toBe(10);
      expect(window.deltaPct).toBeCloseTo(10 / 84251, 5);
    });
  });

  // ── resetWindow() ─────────────────────────────────────────────────────

  describe('resetWindow()', () => {
    it('returns startPrice 0 with no ticks', () => {
      const result = service.resetWindow();
      expect(result.startPrice).toBe(0);
      expect(result.resetAt).toBeDefined();
    });

    it('uses resolver price when available', () => {
      service.handleBookTicker(makeTick(84250, 84252));
      const result = service.resetWindow();
      expect(result.startPrice).toBe(84251);
    });

    it('resets timeToCloseSec to 300', () => {
      service.resetWindow();
      expect(service.getWindowData().timeToCloseSec).toBe(300);
    });

    it('resets delta to 0', () => {
      feedTicks(3);
      service.resetWindow();
      expect(service.getWindowData().deltaAbs).toBe(0);
    });

    it('produces valid ISO timestamp', () => {
      vi.setSystemTime(new Date('2026-03-20T12:00:00.000Z'));
      expect(service.resetWindow().resetAt).toBe('2026-03-20T12:00:00.000Z');
    });
  });

  // ── Micro signals ─────────────────────────────────────────────────────

  describe('micro signals', () => {
    it('returns zero signals with empty buffer', () => {
      const m = service.getCurrentPrice().micro;
      expect(m.return1s).toBe(0);
      expect(m.return5s).toBe(0);
      expect(m.return15s).toBe(0);
      expect(m.volatility).toBe(0);
      expect(m.momentumScore).toBe(0.5);
    });

    it('computes returns after sufficient ticks', () => {
      feedTicks(10);
      const m = service.getCurrentPrice().micro;
      expect(typeof m.return1s).toBe('number');
      expect(typeof m.return5s).toBe('number');
      expect(typeof m.volatility).toBe('number');
    });

    it('computes momentumScore between 0 and 1', () => {
      feedTicks(20);
      const m = service.getCurrentPrice().micro;
      expect(m.momentumScore).toBeGreaterThanOrEqual(0);
      expect(m.momentumScore).toBeLessThanOrEqual(1);
    });

    it('returns 0.5 momentum when volatility is zero', () => {
      expect(service.getCurrentPrice().micro.momentumScore).toBe(0.5);
    });
  });

  // ── Volatility ────────────────────────────────────────────────────────

  describe('volatility', () => {
    it('is zero with fewer than 3 ticks', () => {
      service.handleBookTicker(makeTick(84250, 84252));
      expect(service.getCurrentPrice().micro.volatility).toBe(0);
    });

    it('is non-negative', () => {
      feedTicks(30);
      expect(service.getCurrentPrice().micro.volatility).toBeGreaterThanOrEqual(0);
    });
  });

  // ── Rolling buffer ────────────────────────────────────────────────────

  describe('rolling buffer', () => {
    it('limits buffer size', async () => {
      feedTicks(310);
      const history = await service.getHistory({ from: new Date(0).toISOString(), to: new Date('2030-01-01').toISOString(), source: 'all', interval: '1s' });
      expect(history.count).toBeLessThan(620);
      expect(history.count).toBeLessThanOrEqual(320);
    });
  });

  // ── getHistory() ──────────────────────────────────────────────────────

  describe('getHistory()', () => {
    it('returns empty with no data', async () => {
      const result = await service.getHistory({ from: '2026-03-20T00:00:00Z', to: '2026-03-20T23:59:59Z', source: 'all', interval: '1s' });
      expect(result.ticks).toEqual([]);
    });

    it('filters by time range', async () => {
      vi.setSystemTime(new Date('2026-03-20T10:00:00.000Z'));
      service.resetWindow();
      feedTicks(5);
      const result = await service.getHistory({ from: '2026-03-20T10:00:01.000Z', to: '2026-03-20T10:00:03.000Z', source: 'all', interval: '1s' });
      for (const tick of result.ticks) {
        const ms = new Date(tick.timestamp).getTime();
        expect(ms).toBeGreaterThanOrEqual(new Date('2026-03-20T10:00:01.000Z').getTime());
        expect(ms).toBeLessThanOrEqual(new Date('2026-03-20T10:00:03.000Z').getTime());
      }
    });

    it('filters by source', async () => {
      vi.setSystemTime(new Date('2026-03-20T10:00:00.000Z'));
      service.resetWindow();
      feedTicks(5);
      const result = await service.getHistory({ from: '2026-03-20T09:59:00.000Z', to: '2026-03-20T10:01:00.000Z', source: 'resolver', interval: '1s' });
      for (const tick of result.ticks) {
        expect(tick.source).toBe('resolver');
      }
    });

    it('downsamples with larger intervals', async () => {
      vi.setSystemTime(new Date('2026-03-20T10:00:00.000Z'));
      service.resetWindow();
      feedTicks(20);
      const all = await service.getHistory({ from: '2026-03-20T09:59:00.000Z', to: '2026-03-20T10:01:00.000Z', source: 'all', interval: '1s' });
      const down = await service.getHistory({ from: '2026-03-20T09:59:00.000Z', to: '2026-03-20T10:01:00.000Z', source: 'all', interval: '5s' });
      expect(down.count).toBeLessThanOrEqual(all.count);
    });
  });

  // ── Return computation ────────────────────────────────────────────────

  describe('return computation', () => {
    it('returns 0 with fewer than 2 resolver ticks', () => {
      const m = service.getCurrentPrice().micro;
      expect(m.return1s).toBe(0);
      expect(m.return5s).toBe(0);
      expect(m.return15s).toBe(0);
    });
  });

  // ── Lifecycle ─────────────────────────────────────────────────────────

  describe('lifecycle', () => {
    it('handleBookTicker populates prices', () => {
      service.handleBookTicker(makeTick(84250, 84252));
      const payload = service.getCurrentPrice();
      expect(payload.resolver.price).toBe(84251);
      expect(payload.external.bid).toBe(84250);
    });

    it('onModuleDestroy cleans up without error', () => {
      expect(() => service.onModuleDestroy()).not.toThrow();
    });
  });
});
