import { EventBus } from '@brain/events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FeatureEngineService } from './feature-engine.service';

// ---------------------------------------------------------------------------
// Mock global fetch
// ---------------------------------------------------------------------------

function mockFetchResponses(
  overrides: {
    market?: { marketId: string; secondsToClose: number; start?: string; end?: string; isOpen?: boolean } | null;
    price?: {
      resolver: { price: number };
      external?: { price: number };
      window: { startPrice: number; deltaAbs: number; deltaPct: number };
      micro: { return1s?: number; return5s: number; return15s: number; momentumScore?: number; volatility: number };
    } | null;
    book?: {
      up: { bestBid: number; bestAsk: number; bidDepth: number; askDepth: number };
      down: { bestBid: number; bestAsk: number; bidDepth: number; askDepth: number };
      spreadBps: number;
      imbalance: number;
      liquidityScore: number;
    } | null;
  } = {},
): void {
  const marketData = overrides.market ?? {
    marketId: 'btc-5m-test',
    secondsToClose: 120,
    start: new Date(Date.now() - 180_000).toISOString(),
    end: new Date(Date.now() + 120_000).toISOString(),
    isOpen: true,
  };
  const priceData = overrides.price ?? {
    resolver: { price: 84300 },
    external: { price: 84300 },
    window: { startPrice: 84250, deltaAbs: 50, deltaPct: 0.000593 },
    micro: { return1s: 0.0001, return5s: 0.0002, return15s: 0.0005, momentumScore: 0.55, volatility: 0.0008 },
  };
  const bookData = overrides.book ?? {
    up: { bestBid: 0.55, bestAsk: 0.58, bidDepth: 500, askDepth: 450 },
    down: { bestBid: 0.41, bestAsk: 0.44, bidDepth: 400, askDepth: 420 },
    spreadBps: 530,
    imbalance: 0.05,
    liquidityScore: 0.6,
  };

  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((url: string) => {
      if (url.includes('/market/window/current')) {
        return Promise.resolve({
          json: () => Promise.resolve({ ok: true, data: marketData }),
        });
      }
      if (url.includes('/price/current')) {
        return Promise.resolve({
          json: () => Promise.resolve({ ok: true, data: priceData }),
        });
      }
      if (url.includes('/book/metrics')) {
        return Promise.resolve({
          json: () => Promise.resolve({ ok: true, data: bookData }),
        });
      }
      if (url.includes('/whales/') || url.includes('/derivatives/')) {
        return Promise.resolve({
          json: () => Promise.resolve({ ok: true, data: null }),
        });
      }
      return Promise.reject(new Error(`Unmocked URL: ${url}`));
    }),
  );
}

describe('FeatureEngineService', () => {
  let service: FeatureEngineService;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {
      /* noop */
    });
    vi.spyOn(console, 'error').mockImplementation(() => {
      /* noop */
    });
    service = new FeatureEngineService(null as any, new EventBus());
    mockFetchResponses();
  });

  afterEach(() => {
    service.onModuleDestroy();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // ---------------------------------------------------------------------------
  // getCurrentFeatures()
  // ---------------------------------------------------------------------------

  describe('getCurrentFeatures()', () => {
    it('should return null before recompute', () => {
      const features = service.getCurrentFeatures();
      expect(features).toBeNull();
    });

    it('should return payload after recompute', async () => {
      await service.recompute();
      const features = service.getCurrentFeatures();
      expect(features).not.toBeNull();
      expect(features?.windowId).toBe('btc-5m-test');
    });

    it('should return full @brain/types FeaturePayload shape', async () => {
      await service.recompute();
      const f = service.getCurrentFeatures();
      expect(f).toEqual(
        expect.objectContaining({
          windowId: expect.any(String),
          eventTime: expect.any(Number),
          market: expect.objectContaining({
            windowId: expect.any(String),
            startPrice: expect.any(Number),
            elapsedMs: expect.any(Number),
            remainingMs: expect.any(Number),
          }),
          price: expect.objectContaining({
            currentPrice: expect.any(Number),
            returnBps: expect.any(Number),
            volatility: expect.any(Number),
            momentum: expect.any(Number),
            meanReversionStrength: expect.any(Number),
            tickRate: expect.any(Number),
            binancePrice: expect.any(Number),
            coinbasePrice: expect.any(Number),
            exchangeMidPrice: expect.any(Number),
            polymarketMidPrice: expect.any(Number),
            basisBps: expect.any(Number),
          }),
          book: expect.objectContaining({
            upBid: expect.any(Number),
            upAsk: expect.any(Number),
            downBid: expect.any(Number),
            downAsk: expect.any(Number),
            spreadBps: expect.any(Number),
            depthScore: expect.any(Number),
            imbalance: expect.any(Number),
          }),
          signals: expect.objectContaining({
            priceDirectionScore: expect.any(Number),
            volatilityRegime: expect.any(String),
            bookPressure: expect.any(String),
            basisSignal: expect.any(String),
            tradeable: expect.any(Boolean),
          }),
        }),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // recompute()
  // ---------------------------------------------------------------------------

  describe('recompute()', () => {
    it('should fetch from all upstream services', async () => {
      await service.recompute();
      const fetchMock = vi.mocked(fetch);
      const urls = fetchMock.mock.calls.map((c) => c[0] as string);
      expect(urls.some((u) => u.includes('/market/window/current'))).toBe(true);
      expect(urls.some((u) => u.includes('/price/current'))).toBe(true);
      expect(urls.some((u) => u.includes('/book/metrics'))).toBe(true);
    });

    it('should populate market features from upstream', async () => {
      const payload = await service.recompute();
      expect(payload.market.windowId).toBe('btc-5m-test');
      expect(payload.market.remainingMs).toBe(120_000);
      expect(payload.market.startPrice).toBe(84250);
    });

    it('should populate price features from upstream', async () => {
      const payload = await service.recompute();
      expect(payload.price.currentPrice).toBe(84300);
      expect(payload.price.returnBps).toBeCloseTo(0.0593, 2);
      expect(payload.price.volatility).toBe(0.0008);
    });

    it('should populate book features from upstream', async () => {
      const payload = await service.recompute();
      expect(payload.book.upBid).toBe(0.55);
      expect(payload.book.upAsk).toBe(0.58);
      expect(payload.book.downBid).toBe(0.41);
      expect(payload.book.downAsk).toBe(0.44);
      expect(payload.book.spreadBps).toBe(530);
      expect(payload.book.depthScore).toBe(0.6);
      expect(payload.book.imbalance).toBe(0.05);
    });

    it('should compute polymarketMidPrice from book', async () => {
      const payload = await service.recompute();
      // (0.55 + 0.58) / 2 = 0.565
      expect(payload.price.polymarketMidPrice).toBeCloseTo(0.565, 3);
    });

    it('should use fallback values when market service is unavailable', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation((url: string) => {
          if (url.includes('/market/window/current')) {
            return Promise.reject(new Error('Connection refused'));
          }
          if (url.includes('/price/current')) {
            return Promise.resolve({
              json: () =>
                Promise.resolve({
                  ok: true,
                  data: {
                    resolver: { price: 84300 },
                    external: { price: 84300 },
                    window: { startPrice: 84250, deltaAbs: 50, deltaPct: 0.000593 },
                    micro: { return1s: 0, return5s: 0.0002, return15s: 0.0005, momentumScore: 0.5, volatility: 0.0008 },
                  },
                }),
            });
          }
          if (url.includes('/book/metrics')) {
            return Promise.resolve({
              json: () =>
                Promise.resolve({
                  ok: true,
                  data: {
                    up: { bestBid: 0.55, bestAsk: 0.58, bidDepth: 500, askDepth: 450 },
                    down: { bestBid: 0.41, bestAsk: 0.44, bidDepth: 400, askDepth: 420 },
                    spreadBps: 530,
                    imbalance: 0.05,
                    liquidityScore: 0.6,
                  },
                }),
            });
          }
          return Promise.resolve({ json: () => Promise.resolve({ ok: true, data: null }) });
        }),
      );

      const payload = await service.recompute();
      expect(payload.market.windowId).toBe('btc-5m-unknown');
      expect(payload.market.remainingMs).toBe(0);
    });

    it('should use fallback values when price service is unavailable', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation((url: string) => {
          if (url.includes('/price/current')) {
            return Promise.reject(new Error('Connection refused'));
          }
          if (url.includes('/market/window/current')) {
            return Promise.resolve({
              json: () => Promise.resolve({ ok: true, data: { marketId: 'btc-5m-test', secondsToClose: 120, start: new Date().toISOString(), end: new Date().toISOString(), isOpen: true } }),
            });
          }
          if (url.includes('/book/metrics')) {
            return Promise.resolve({
              json: () => Promise.resolve({ ok: true, data: { up: { bestBid: 0.55, bestAsk: 0.58, bidDepth: 500, askDepth: 450 }, down: { bestBid: 0.41, bestAsk: 0.44, bidDepth: 400, askDepth: 420 }, spreadBps: 530, imbalance: 0.05, liquidityScore: 0.6 } }),
            });
          }
          return Promise.resolve({ json: () => Promise.resolve({ ok: true, data: null }) });
        }),
      );

      const payload = await service.recompute();
      expect(payload.price.currentPrice).toBe(0);
    });

    it('should store payload in history', async () => {
      await service.recompute();
      await service.recompute();

      const history = await service.getHistory({
        from: new Date(0).toISOString(),
        to: new Date('2030-01-01').toISOString(),
      });
      expect(history.count).toBe(2);
    });

    it('should cap history at 300 entries', async () => {
      for (let i = 0; i < 310; i++) {
        await service.recompute();
      }

      const history = await service.getHistory({
        from: new Date(0).toISOString(),
        to: new Date('2030-01-01').toISOString(),
      });
      expect(history.count).toBeLessThanOrEqual(300);
    });

    it('should emit features.computed event', async () => {
      const spy = vi.spyOn(service as any, 'emitEvent');
      await service.recompute();
      expect(spy).toHaveBeenCalledWith(
        'features.computed',
        expect.objectContaining({ marketId: expect.any(String), tradeable: expect.any(Boolean) }),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Tradeability checks
  // ---------------------------------------------------------------------------

  describe('tradeability', () => {
    it('should be tradeable with good conditions', async () => {
      const payload = await service.recompute();
      expect(payload.signals.tradeable).toBe(true);
    });

    it('should NOT be tradeable when timeToClose < 15 seconds', async () => {
      mockFetchResponses({
        market: { marketId: 'btc-5m-test', secondsToClose: 10 },
      });
      const payload = await service.recompute();
      expect(payload.signals.tradeable).toBe(false);
    });

    it('should NOT be tradeable when depthScore < 0.3', async () => {
      mockFetchResponses({
        book: {
          up: { bestBid: 0.55, bestAsk: 0.58, bidDepth: 50, askDepth: 45 },
          down: { bestBid: 0.41, bestAsk: 0.44, bidDepth: 40, askDepth: 42 },
          spreadBps: 530,
          imbalance: 0.05,
          liquidityScore: 0.2,
        },
      });
      const payload = await service.recompute();
      expect(payload.signals.tradeable).toBe(false);
    });

    it('should NOT be tradeable when spreadBps > 800', async () => {
      mockFetchResponses({
        book: {
          up: { bestBid: 0.55, bestAsk: 0.58, bidDepth: 500, askDepth: 450 },
          down: { bestBid: 0.41, bestAsk: 0.44, bidDepth: 400, askDepth: 420 },
          spreadBps: 900,
          imbalance: 0.05,
          liquidityScore: 0.6,
        },
      });
      const payload = await service.recompute();
      expect(payload.signals.tradeable).toBe(false);
    });

    it('should NOT be tradeable when volatility < 0.0001', async () => {
      mockFetchResponses({
        price: {
          resolver: { price: 84300 },
          external: { price: 84300 },
          window: { startPrice: 84250, deltaAbs: 50, deltaPct: 0.000593 },
          micro: { return5s: 0.0002, return15s: 0.0005, momentumScore: 0.5, volatility: 0.00005 },
        },
      });
      const payload = await service.recompute();
      expect(payload.signals.tradeable).toBe(false);
    });

    it('should be tradeable at exact boundary values', async () => {
      mockFetchResponses({
        market: { marketId: 'btc-5m-test', secondsToClose: 15 },
        book: {
          up: { bestBid: 0.55, bestAsk: 0.58, bidDepth: 500, askDepth: 450 },
          down: { bestBid: 0.41, bestAsk: 0.44, bidDepth: 400, askDepth: 420 },
          spreadBps: 800,
          imbalance: 0.05,
          liquidityScore: 0.3,
        },
        price: {
          resolver: { price: 84300 },
          external: { price: 84300 },
          window: { startPrice: 84250, deltaAbs: 50, deltaPct: 0.000593 },
          micro: { return5s: 0.0002, return15s: 0.0005, momentumScore: 0.5, volatility: 0.0001 },
        },
      });
      const payload = await service.recompute();
      expect(payload.signals.tradeable).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Signal classification
  // ---------------------------------------------------------------------------

  describe('signal classification', () => {
    it('volatilityRegime should classify low/medium/high', async () => {
      // Default volatility 0.0008 < 0.001 threshold → low
      const payload = await service.recompute();
      expect(payload.signals.volatilityRegime).toBe('low');
    });

    it('bookPressure should classify bid/ask/neutral', async () => {
      // Default imbalance 0.05 → neutral (< 0.15)
      const payload = await service.recompute();
      expect(payload.signals.bookPressure).toBe('neutral');
    });

    it('bookPressure should be bid when imbalance > 0.15', async () => {
      mockFetchResponses({
        book: {
          up: { bestBid: 0.55, bestAsk: 0.58, bidDepth: 1000, askDepth: 200 },
          down: { bestBid: 0.41, bestAsk: 0.44, bidDepth: 200, askDepth: 1000 },
          spreadBps: 530,
          imbalance: 0.5,
          liquidityScore: 0.6,
        },
      });
      const payload = await service.recompute();
      expect(payload.signals.bookPressure).toBe('bid');
    });

    it('bookPressure should be ask when imbalance < -0.15', async () => {
      mockFetchResponses({
        book: {
          up: { bestBid: 0.33, bestAsk: 0.34, bidDepth: 200, askDepth: 1000 },
          down: { bestBid: 0.65, bestAsk: 0.66, bidDepth: 1000, askDepth: 200 },
          spreadBps: 530,
          imbalance: -0.5,
          liquidityScore: 0.6,
        },
      });
      const payload = await service.recompute();
      expect(payload.signals.bookPressure).toBe('ask');
    });

    it('priceDirectionScore should be between -1 and 1', async () => {
      const payload = await service.recompute();
      expect(payload.signals.priceDirectionScore).toBeGreaterThanOrEqual(-1);
      expect(payload.signals.priceDirectionScore).toBeLessThanOrEqual(1);
    });
  });

  // ---------------------------------------------------------------------------
  // getHistory()
  // ---------------------------------------------------------------------------

  describe('getHistory()', () => {
    it('should return empty before any recomputes', async () => {
      const result = await service.getHistory({
        from: '2026-03-20T00:00:00Z',
        to: '2026-03-20T23:59:59Z',
      });
      expect(result.snapshots).toEqual([]);
      expect(result.count).toBe(0);
    });

    it('should filter by time range', async () => {
      vi.setSystemTime(new Date('2026-03-20T10:00:00.000Z'));
      await service.recompute();

      vi.setSystemTime(new Date('2026-03-20T10:00:05.000Z'));
      await service.recompute();

      vi.setSystemTime(new Date('2026-03-20T10:00:10.000Z'));
      await service.recompute();

      const result = await service.getHistory({
        from: '2026-03-20T10:00:03.000Z',
        to: '2026-03-20T10:00:07.000Z',
      });

      expect(result.count).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Compute loop lifecycle
  // ---------------------------------------------------------------------------

  describe('compute loop', () => {
    it('should start computing on onModuleInit', async () => {
      await service.onModuleInit();
      const features = service.getCurrentFeatures();
      expect(features).not.toBeNull();
    });

    it('should recompute every second', async () => {
      vi.setSystemTime(new Date('2026-03-20T10:00:00.000Z'));
      await service.onModuleInit();

      vi.setSystemTime(new Date('2026-03-20T10:00:01.000Z'));
      await vi.advanceTimersByTimeAsync(1_000);

      vi.setSystemTime(new Date('2026-03-20T10:00:02.000Z'));
      await vi.advanceTimersByTimeAsync(1_000);

      const history = await service.getHistory({
        from: '2026-03-20T00:00:00Z',
        to: '2026-03-21T00:00:00Z',
      });

      // Initial + 2 interval recomputes = 3
      expect(history.count).toBe(3);
    });

    it('should stop computing on onModuleDestroy', async () => {
      await service.onModuleInit();
      service.onModuleDestroy();

      const countBefore = (
        await service.getHistory({
          from: new Date(0).toISOString(),
          to: new Date('2030-01-01').toISOString(),
        })
      ).count;

      await vi.advanceTimersByTimeAsync(5_000);

      const countAfter = (
        await service.getHistory({
          from: new Date(0).toISOString(),
          to: new Date('2030-01-01').toISOString(),
        })
      ).count;

      expect(countAfter).toBe(countBefore);
    });

    it('should handle recompute errors gracefully', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));

      await service.onModuleInit();
      await vi.advanceTimersByTimeAsync(3_000);

      const features = service.getCurrentFeatures();
      expect(features).not.toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // getWindowFeatures()
  // ---------------------------------------------------------------------------

  describe('getWindowFeatures()', () => {
    it('should return same payload as getCurrentFeatures', async () => {
      await service.recompute();
      const current = service.getCurrentFeatures();
      const window = service.getWindowFeatures();
      expect(current).toEqual(window);
    });

    it('should return null before recompute', () => {
      const result = service.getWindowFeatures();
      expect(result).toBeNull();
    });
  });
});
