import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FeatureEngineService } from './feature-engine.service';

// ---------------------------------------------------------------------------
// Mock global fetch
// ---------------------------------------------------------------------------

function mockFetchResponses(
  overrides: {
    market?: { marketId: string; secondsToClose: number } | null;
    price?: {
      resolver: { price: number };
      window: { startPrice: number; deltaAbs: number; deltaPct: number };
      micro: { return5s: number; return15s: number; volatility: number };
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
  const marketData = overrides.market ?? { marketId: 'btc-5m-test', secondsToClose: 120 };
  const priceData = overrides.price ?? {
    resolver: { price: 84300 },
    window: { startPrice: 84250, deltaAbs: 50, deltaPct: 0.000593 },
    micro: { return5s: 0.0002, return15s: 0.0005, volatility: 0.0008 },
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
    service = new FeatureEngineService();
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
    it('should return null before recompute', async () => {
      const features = await service.getCurrentFeatures();
      expect(features).toBeNull();
    });

    it('should return payload after recompute', async () => {
      await service.recompute();
      const features = await service.getCurrentFeatures();
      expect(features).not.toBeNull();
      expect(features?.market.marketId).toBe('btc-5m-test');
    });

    it('should return full payload shape', async () => {
      await service.recompute();
      const f = await service.getCurrentFeatures();
      expect(f).toEqual(
        expect.objectContaining({
          market: expect.objectContaining({
            marketId: expect.any(String),
            timeToCloseSec: expect.any(Number),
          }),
          price: expect.objectContaining({
            startPrice: expect.any(Number),
            resolverPrice: expect.any(Number),
            deltaAbs: expect.any(Number),
            deltaPct: expect.any(Number),
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
            momentum5s: expect.any(Number),
            momentum15s: expect.any(Number),
            volatility30s: expect.any(Number),
            bookPressure: expect.any(Number),
            tradeable: expect.any(Boolean),
          }),
          computedAt: expect.any(String),
        }),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // recompute()
  // ---------------------------------------------------------------------------

  describe('recompute()', () => {
    it('should fetch from all three upstream services', async () => {
      await service.recompute();
      const fetchMock = vi.mocked(fetch);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      const urls = fetchMock.mock.calls.map((c) => c[0] as string);
      expect(urls.some((u) => u.includes('/market/window/current'))).toBe(true);
      expect(urls.some((u) => u.includes('/price/current'))).toBe(true);
      expect(urls.some((u) => u.includes('/book/metrics'))).toBe(true);
    });

    it('should populate market features from upstream', async () => {
      const payload = await service.recompute();
      expect(payload.market.marketId).toBe('btc-5m-test');
      expect(payload.market.timeToCloseSec).toBe(120);
    });

    it('should populate price features from upstream', async () => {
      const payload = await service.recompute();
      expect(payload.price.startPrice).toBe(84250);
      expect(payload.price.resolverPrice).toBe(84300);
      expect(payload.price.deltaAbs).toBe(50);
      expect(payload.price.deltaPct).toBeCloseTo(0.000593, 5);
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
                    window: { startPrice: 84250, deltaAbs: 50, deltaPct: 0.000593 },
                    micro: { return5s: 0.0002, return15s: 0.0005, volatility: 0.0008 },
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
          return Promise.reject(new Error('Unmocked'));
        }),
      );

      const payload = await service.recompute();
      expect(payload.market.marketId).toBe('btc-5m-unknown');
      expect(payload.market.timeToCloseSec).toBe(0);
    });

    it('should use fallback values when price service is unavailable', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation((url: string) => {
          if (url.includes('/market/window/current')) {
            return Promise.resolve({
              json: () =>
                Promise.resolve({
                  ok: true,
                  data: { marketId: 'btc-5m-test', secondsToClose: 120 },
                }),
            });
          }
          if (url.includes('/price/current')) {
            return Promise.reject(new Error('Connection refused'));
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
          return Promise.reject(new Error('Unmocked'));
        }),
      );

      const payload = await service.recompute();
      expect(payload.price.startPrice).toBe(0);
      expect(payload.price.resolverPrice).toBe(0);
    });

    it('should use fallback values when book service is unavailable', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation((url: string) => {
          if (url.includes('/market/window/current')) {
            return Promise.resolve({
              json: () =>
                Promise.resolve({
                  ok: true,
                  data: { marketId: 'btc-5m-test', secondsToClose: 120 },
                }),
            });
          }
          if (url.includes('/price/current')) {
            return Promise.resolve({
              json: () =>
                Promise.resolve({
                  ok: true,
                  data: {
                    resolver: { price: 84300 },
                    window: { startPrice: 84250, deltaAbs: 50, deltaPct: 0.000593 },
                    micro: { return5s: 0.0002, return15s: 0.0005, volatility: 0.0008 },
                  },
                }),
            });
          }
          if (url.includes('/book/metrics')) {
            return Promise.reject(new Error('Connection refused'));
          }
          return Promise.reject(new Error('Unmocked'));
        }),
      );

      const payload = await service.recompute();
      expect(payload.book.spreadBps).toBe(9999);
      expect(payload.book.depthScore).toBe(0);
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
      const spy = vi.spyOn(service as unknown as Record<string, unknown>, 'emitEvent');
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
      mockFetchResponses({
        market: { marketId: 'btc-5m-test', secondsToClose: 120 },
        book: {
          up: { bestBid: 0.55, bestAsk: 0.58, bidDepth: 500, askDepth: 450 },
          down: { bestBid: 0.41, bestAsk: 0.44, bidDepth: 400, askDepth: 420 },
          spreadBps: 530,
          imbalance: 0.05,
          liquidityScore: 0.6,
        },
        price: {
          resolver: { price: 84300 },
          window: { startPrice: 84250, deltaAbs: 50, deltaPct: 0.000593 },
          micro: { return5s: 0.0002, return15s: 0.0005, volatility: 0.0008 },
        },
      });

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
        market: { marketId: 'btc-5m-test', secondsToClose: 120 },
        book: {
          up: { bestBid: 0.55, bestAsk: 0.58, bidDepth: 50, askDepth: 45 },
          down: { bestBid: 0.41, bestAsk: 0.44, bidDepth: 40, askDepth: 42 },
          spreadBps: 530,
          imbalance: 0.05,
          liquidityScore: 0.2, // below MIN_DEPTH_SCORE (0.3)
        },
      });

      const payload = await service.recompute();
      expect(payload.signals.tradeable).toBe(false);
    });

    it('should NOT be tradeable when spreadBps > 800', async () => {
      mockFetchResponses({
        market: { marketId: 'btc-5m-test', secondsToClose: 120 },
        book: {
          up: { bestBid: 0.55, bestAsk: 0.58, bidDepth: 500, askDepth: 450 },
          down: { bestBid: 0.41, bestAsk: 0.44, bidDepth: 400, askDepth: 420 },
          spreadBps: 900, // above MAX_SPREAD_BPS (800)
          imbalance: 0.05,
          liquidityScore: 0.6,
        },
      });

      const payload = await service.recompute();
      expect(payload.signals.tradeable).toBe(false);
    });

    it('should NOT be tradeable when volatility < 0.0001', async () => {
      mockFetchResponses({
        market: { marketId: 'btc-5m-test', secondsToClose: 120 },
        price: {
          resolver: { price: 84300 },
          window: { startPrice: 84250, deltaAbs: 50, deltaPct: 0.000593 },
          micro: { return5s: 0.0002, return15s: 0.0005, volatility: 0.00005 }, // below MIN_VOLATILITY
        },
      });

      const payload = await service.recompute();
      expect(payload.signals.tradeable).toBe(false);
    });

    it('should be tradeable at exact boundary values', async () => {
      mockFetchResponses({
        market: { marketId: 'btc-5m-test', secondsToClose: 15 }, // exactly MIN_TIME_TO_CLOSE_SEC
        book: {
          up: { bestBid: 0.55, bestAsk: 0.58, bidDepth: 500, askDepth: 450 },
          down: { bestBid: 0.41, bestAsk: 0.44, bidDepth: 400, askDepth: 420 },
          spreadBps: 800, // exactly MAX_SPREAD_BPS
          imbalance: 0.05,
          liquidityScore: 0.3, // exactly MIN_DEPTH_SCORE
        },
        price: {
          resolver: { price: 84300 },
          window: { startPrice: 84250, deltaAbs: 50, deltaPct: 0.000593 },
          micro: { return5s: 0.0002, return15s: 0.0005, volatility: 0.0001 }, // exactly MIN_VOLATILITY
        },
      });

      const payload = await service.recompute();
      // At exact boundaries: timeToClose >= 15 (not <), depthScore >= 0.3 (not <),
      // spreadBps <= 800 (not >), volatility >= 0.0001 (not <)
      expect(payload.signals.tradeable).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Momentum signal computation
  // ---------------------------------------------------------------------------

  describe('momentum signal', () => {
    it('should return 0.5 when volatility is zero', async () => {
      mockFetchResponses({
        price: {
          resolver: { price: 84300 },
          window: { startPrice: 84250, deltaAbs: 50, deltaPct: 0.000593 },
          micro: { return5s: 0.001, return15s: 0.002, volatility: 0 },
        },
      });

      const payload = await service.recompute();
      expect(payload.signals.momentum5s).toBe(0.5);
      expect(payload.signals.momentum15s).toBe(0.5);
    });

    it('should compute momentum > 0.5 for positive returns', async () => {
      mockFetchResponses({
        price: {
          resolver: { price: 84300 },
          window: { startPrice: 84250, deltaAbs: 50, deltaPct: 0.000593 },
          micro: { return5s: 0.005, return15s: 0.003, volatility: 0.001 },
        },
      });

      const payload = await service.recompute();
      expect(payload.signals.momentum5s).toBeGreaterThan(0.5);
      expect(payload.signals.momentum15s).toBeGreaterThan(0.5);
    });

    it('should compute momentum < 0.5 for negative returns', async () => {
      mockFetchResponses({
        price: {
          resolver: { price: 84200 },
          window: { startPrice: 84250, deltaAbs: -50, deltaPct: -0.000593 },
          micro: { return5s: -0.005, return15s: -0.003, volatility: 0.001 },
        },
      });

      const payload = await service.recompute();
      expect(payload.signals.momentum5s).toBeLessThan(0.5);
      expect(payload.signals.momentum15s).toBeLessThan(0.5);
    });

    it('should keep momentum between 0 and 1', async () => {
      // Extreme positive return
      mockFetchResponses({
        price: {
          resolver: { price: 85000 },
          window: { startPrice: 84000, deltaAbs: 1000, deltaPct: 0.0119 },
          micro: { return5s: 0.1, return15s: 0.05, volatility: 0.0001 },
        },
      });

      const payload = await service.recompute();
      expect(payload.signals.momentum5s).toBeGreaterThanOrEqual(0);
      expect(payload.signals.momentum5s).toBeLessThanOrEqual(1);
      expect(payload.signals.momentum15s).toBeGreaterThanOrEqual(0);
      expect(payload.signals.momentum15s).toBeLessThanOrEqual(1);
    });

    it('should pass through volatility30s from upstream', async () => {
      mockFetchResponses({
        price: {
          resolver: { price: 84300 },
          window: { startPrice: 84250, deltaAbs: 50, deltaPct: 0.000593 },
          micro: { return5s: 0.0002, return15s: 0.0005, volatility: 0.0042 },
        },
      });

      const payload = await service.recompute();
      expect(payload.signals.volatility30s).toBeCloseTo(0.0042, 4);
    });
  });

  // ---------------------------------------------------------------------------
  // Book pressure calculation
  // ---------------------------------------------------------------------------

  describe('book pressure', () => {
    it('should be between -1 and 1', async () => {
      const payload = await service.recompute();
      expect(payload.signals.bookPressure).toBeGreaterThanOrEqual(-1);
      expect(payload.signals.bookPressure).toBeLessThanOrEqual(1);
    });

    it('should be positive when UP side dominates', async () => {
      mockFetchResponses({
        book: {
          up: { bestBid: 0.65, bestAsk: 0.66, bidDepth: 1000, askDepth: 200 },
          down: { bestBid: 0.33, bestAsk: 0.34, bidDepth: 200, askDepth: 1000 },
          spreadBps: 150,
          imbalance: 0.5, // strong bid imbalance
          liquidityScore: 0.8,
        },
      });

      const payload = await service.recompute();
      // Positive imbalance + UP mid > DOWN mid => positive pressure
      expect(payload.signals.bookPressure).toBeGreaterThan(0);
    });

    it('should be negative when DOWN side dominates', async () => {
      mockFetchResponses({
        book: {
          up: { bestBid: 0.33, bestAsk: 0.34, bidDepth: 200, askDepth: 1000 },
          down: { bestBid: 0.65, bestAsk: 0.66, bidDepth: 1000, askDepth: 200 },
          spreadBps: 150,
          imbalance: -0.5, // strong ask imbalance
          liquidityScore: 0.8,
        },
      });

      const payload = await service.recompute();
      // Negative imbalance + DOWN mid > UP mid => negative pressure
      expect(payload.signals.bookPressure).toBeLessThan(0);
    });

    it('should be near zero when book is balanced', async () => {
      mockFetchResponses({
        book: {
          up: { bestBid: 0.49, bestAsk: 0.51, bidDepth: 500, askDepth: 500 },
          down: { bestBid: 0.49, bestAsk: 0.51, bidDepth: 500, askDepth: 500 },
          spreadBps: 400,
          imbalance: 0.0,
          liquidityScore: 0.5,
        },
      });

      const payload = await service.recompute();
      expect(Math.abs(payload.signals.bookPressure)).toBeLessThan(0.1);
    });

    it('should incorporate spread ratio component', async () => {
      // UP has tighter spread than DOWN => positive spreadRatio component
      mockFetchResponses({
        book: {
          up: { bestBid: 0.54, bestAsk: 0.55, bidDepth: 500, askDepth: 500 },
          down: { bestBid: 0.4, bestAsk: 0.5, bidDepth: 500, askDepth: 500 },
          spreadBps: 200,
          imbalance: 0.0,
          liquidityScore: 0.5,
        },
      });

      const payload = await service.recompute();
      // upSpread = 0.01, downSpread = 0.10 => spreadRatio = (0.10 - 0.01) / 0.11 ~ 0.82 (positive => UP bias)
      // midDivergence = (0.545) - (0.45) = 0.095 (positive)
      // Should have positive pressure
      expect(payload.signals.bookPressure).toBeGreaterThan(0);
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
      const features = await service.getCurrentFeatures();
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

      // Should not throw
      await service.onModuleInit();
      await vi.advanceTimersByTimeAsync(3_000);

      // Service still works, uses fallback data
      const features = await service.getCurrentFeatures();
      expect(features).not.toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // getWindowFeatures()
  // ---------------------------------------------------------------------------

  describe('getWindowFeatures()', () => {
    it('should return same payload as getCurrentFeatures', async () => {
      await service.recompute();
      const current = await service.getCurrentFeatures();
      const window = await service.getWindowFeatures();
      expect(current).toEqual(window);
    });

    it('should return null before recompute', async () => {
      const result = await service.getWindowFeatures();
      expect(result).toBeNull();
    });
  });
});
