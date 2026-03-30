import { DATABASE_CLIENT, type DbClient, featureSnapshots } from '@brain/database';
import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { and, desc, gte, lte } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MarketFeatures {
  marketId: string;
  timeToCloseSec: number;
}

interface PriceFeatures {
  startPrice: number;
  resolverPrice: number;
  deltaAbs: number;
  deltaPct: number;
}

interface BookFeatures {
  upBid: number;
  upAsk: number;
  downBid: number;
  downAsk: number;
  spreadBps: number;
  depthScore: number;
  imbalance: number;
}

interface SignalFeatures {
  momentum5s: number;
  momentum15s: number;
  volatility30s: number;
  bookPressure: number;
  tradeable: boolean;
}

interface FeaturePayload {
  market: MarketFeatures;
  price: PriceFeatures;
  book: BookFeatures;
  signals: SignalFeatures;
  computedAt: string;
}

interface HistoryQuery {
  from: string;
  to: string;
}

// ---------------------------------------------------------------------------
// Service base URLs (configurable via @brain/config)
// ---------------------------------------------------------------------------

const MARKET_SERVICE_URL = process.env.MARKET_SERVICE_URL ?? 'http://localhost:3001';
const PRICE_SERVICE_URL = process.env.PRICE_SERVICE_URL ?? 'http://localhost:3002';
const BOOK_SERVICE_URL = process.env.BOOK_SERVICE_URL ?? 'http://localhost:3003';

const RECOMPUTE_INTERVAL_MS = 1_000;
const HISTORY_BUFFER_SIZE = 300;

// Tradeability thresholds
const MIN_TIME_TO_CLOSE_SEC = 15;
const MIN_DEPTH_SCORE = 0.3;
const MAX_SPREAD_BPS = 800;
const MIN_VOLATILITY = 0.0001;

@Injectable()
export class FeatureEngineService implements OnModuleInit, OnModuleDestroy {
  private currentPayload: FeaturePayload | null = null;
  private payloadHistory: FeaturePayload[] = [];
  private computeTimer: ReturnType<typeof setInterval> | null = null;

  constructor(@Inject(DATABASE_CLIENT) private readonly db: DbClient) {}

  async onModuleInit(): Promise<void> {
    await this.recompute();
    this.startComputeLoop();
  }

  onModuleDestroy(): void {
    this.stopComputeLoop();
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  getCurrentFeatures(): FeaturePayload | null {
    return this.currentPayload;
  }

  getWindowFeatures(): FeaturePayload | null {
    // Returns the same payload since it already reflects the current window
    return this.currentPayload;
  }

  async getHistory(query: HistoryQuery): Promise<{ snapshots: FeaturePayload[]; count: number }> {
    const fromMs = new Date(query.from).getTime();
    const toMs = new Date(query.to).getTime();

    // Try database first
    try {
      const rows = await this.db
        .select()
        .from(featureSnapshots)
        .where(and(gte(featureSnapshots.eventTime, fromMs), lte(featureSnapshots.eventTime, toMs)))
        .orderBy(desc(featureSnapshots.eventTime));

      if (rows.length > 0) {
        return {
          snapshots: rows.map((r) => r.payload as unknown as FeaturePayload),
          count: rows.length,
        };
      }
    } catch {
      /* fall through */
    }

    // Fall back to in-memory
    const filtered = this.payloadHistory.filter((p) => {
      const pMs = new Date(p.computedAt).getTime();
      return pMs >= fromMs && pMs <= toMs;
    });

    return { snapshots: filtered, count: filtered.length };
  }

  /**
   * Recomputes the full feature payload by fetching upstream service data
   * and running signal computations.
   */
  async recompute(): Promise<FeaturePayload> {
    const [marketData, priceData, bookData] = await Promise.all([
      this.fetchMarketData(),
      this.fetchPriceData(),
      this.fetchBookData(),
    ]);

    // Build market features
    const market: MarketFeatures = {
      marketId: marketData.marketId,
      timeToCloseSec: marketData.timeToCloseSec,
    };

    // Build price features
    const price: PriceFeatures = {
      startPrice: priceData.startPrice,
      resolverPrice: priceData.resolverPrice,
      deltaAbs: priceData.deltaAbs,
      deltaPct: priceData.deltaPct,
    };

    // Build book features
    const book: BookFeatures = {
      upBid: bookData.upBid,
      upAsk: bookData.upAsk,
      downBid: bookData.downBid,
      downAsk: bookData.downAsk,
      spreadBps: bookData.spreadBps,
      depthScore: bookData.depthScore,
      imbalance: bookData.imbalance,
    };

    // Compute derived signals
    const signals = this.computeSignals(price, book, market, priceData);

    const payload: FeaturePayload = {
      market,
      price,
      book,
      signals,
      computedAt: new Date().toISOString(),
    };

    this.currentPayload = payload;

    // Store in history buffer
    this.payloadHistory.push(payload);
    if (this.payloadHistory.length > HISTORY_BUFFER_SIZE) {
      this.payloadHistory = this.payloadHistory.slice(-HISTORY_BUFFER_SIZE);
    }

    // Persist to database
    try {
      await this.db.insert(featureSnapshots).values({
        windowId: payload.market.marketId,
        payload: payload as unknown as Record<string, unknown>,
        eventTime: new Date(payload.computedAt).getTime(),
        processedAt: Date.now(),
      });
    } catch {
      /* ignore - feature snapshots are high-frequency */
    }

    // Emit event
    this.emitEvent('features.computed', {
      marketId: market.marketId,
      tradeable: signals.tradeable,
      timeToCloseSec: market.timeToCloseSec,
    });

    return payload;
  }

  // ---------------------------------------------------------------------------
  // Compute loop
  // ---------------------------------------------------------------------------

  private startComputeLoop(): void {
    this.computeTimer = setInterval(async () => {
      try {
        await this.recompute();
      } catch (_error) {
        /* ignored - will retry on next interval */
      }
    }, RECOMPUTE_INTERVAL_MS);
  }

  private stopComputeLoop(): void {
    if (this.computeTimer) {
      clearInterval(this.computeTimer);
      this.computeTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Signal computation
  // ---------------------------------------------------------------------------

  /**
   * Computes derived trading signals from raw features.
   */
  private computeSignals(
    _price: PriceFeatures,
    book: BookFeatures,
    market: MarketFeatures,
    rawPrice: RawPriceData,
  ): SignalFeatures {
    // Momentum: EMA-like weighting of short returns
    const momentum5s = this.computeMomentumSignal(rawPrice.return5s, rawPrice.volatility);
    const momentum15s = this.computeMomentumSignal(rawPrice.return15s, rawPrice.volatility);

    // Volatility over 30s window (passed through from price service)
    const volatility30s = rawPrice.volatility;

    // Book pressure: combines imbalance with depth asymmetry
    const bookPressure = this.computeBookPressure(book);

    // Tradeability: composite check of market conditions
    const tradeable = this.assessTradeability(market, book, volatility30s);

    return {
      momentum5s: round(momentum5s, 4),
      momentum15s: round(momentum15s, 4),
      volatility30s: round(volatility30s, 4),
      bookPressure: round(bookPressure, 4),
      tradeable,
    };
  }

  /**
   * Converts a raw return into a normalized momentum signal (0..1).
   * Uses volatility as the normalizing denominator.
   */
  private computeMomentumSignal(returnVal: number, volatility: number): number {
    if (volatility === 0) return 0.5;
    const zScore = returnVal / (volatility || 0.001);
    // Sigmoid mapping to 0..1
    return 1 / (1 + Math.exp(-zScore * 3));
  }

  /**
   * Computes book pressure from imbalance and bid/ask spread asymmetry.
   * Positive pressure indicates buying pressure (UP bias).
   * Returns -1..1 where 0 is neutral.
   */
  private computeBookPressure(book: BookFeatures): number {
    // Component 1: raw imbalance (-1..1)
    const imbalanceComponent = book.imbalance;

    // Component 2: mid divergence between UP and DOWN tokens
    // If UP mid > 0.5, market leans UP; if DOWN mid > 0.5, market leans DOWN
    const upMid = (book.upBid + book.upAsk) / 2;
    const downMid = (book.downBid + book.downAsk) / 2;
    const midDivergence = upMid - downMid; // positive = UP bias

    // Component 3: spread ratio (tighter spread on one side = more confidence)
    const upSpread = book.upAsk - book.upBid;
    const downSpread = book.downAsk - book.downBid;
    const totalSpread = upSpread + downSpread;
    const spreadRatio = totalSpread > 0 ? (downSpread - upSpread) / totalSpread : 0; // positive = UP has tighter spread

    // Weighted combination
    const pressure = imbalanceComponent * 0.4 + midDivergence * 0.35 + spreadRatio * 0.25;
    return Math.max(-1, Math.min(1, pressure));
  }

  /**
   * Determines whether current market conditions are suitable for trading.
   */
  private assessTradeability(
    market: MarketFeatures,
    book: BookFeatures,
    volatility: number,
  ): boolean {
    // Must have enough time left in the window
    if (market.timeToCloseSec < MIN_TIME_TO_CLOSE_SEC) return false;

    // Must have sufficient liquidity
    if (book.depthScore < MIN_DEPTH_SCORE) return false;

    // Spread must not be too wide
    if (book.spreadBps > MAX_SPREAD_BPS) return false;

    // Must have some price movement (not completely flat)
    if (volatility < MIN_VOLATILITY) return false;

    return true;
  }

  // ---------------------------------------------------------------------------
  // Upstream data fetching
  // ---------------------------------------------------------------------------

  private async fetchMarketData(): Promise<{ marketId: string; timeToCloseSec: number }> {
    try {
      const res = await fetch(`${MARKET_SERVICE_URL}/api/v1/market/window/current`);
      const json = (await res.json()) as {
        ok: boolean;
        data: { marketId: string; secondsToClose: number } | null;
      };
      if (json.ok && json.data) {
        return { marketId: json.data.marketId, timeToCloseSec: json.data.secondsToClose };
      }
    } catch {
      // Fallback to stub if service unavailable
    }
    return { marketId: 'btc-5m-unknown', timeToCloseSec: 0 };
  }

  private async fetchPriceData(): Promise<RawPriceData> {
    try {
      const res = await fetch(`${PRICE_SERVICE_URL}/api/v1/price/current`);
      const json = (await res.json()) as {
        ok: boolean;
        data: {
          resolver: { price: number };
          window: { startPrice: number; deltaAbs: number; deltaPct: number };
          micro: { return5s: number; return15s: number; volatility: number };
        } | null;
      };
      if (json.ok && json.data) {
        return {
          startPrice: json.data.window.startPrice,
          resolverPrice: json.data.resolver.price,
          deltaAbs: json.data.window.deltaAbs,
          deltaPct: json.data.window.deltaPct,
          return5s: json.data.micro.return5s,
          return15s: json.data.micro.return15s,
          volatility: json.data.micro.volatility,
        };
      }
    } catch {
      // Fallback
    }
    return {
      startPrice: 0,
      resolverPrice: 0,
      deltaAbs: 0,
      deltaPct: 0,
      return5s: 0,
      return15s: 0,
      volatility: 0,
    };
  }

  private async fetchBookData(): Promise<RawBookData> {
    try {
      const res = await fetch(`${BOOK_SERVICE_URL}/api/v1/book/metrics`);
      const json = (await res.json()) as {
        ok: boolean;
        data: {
          up: { bestBid: number; bestAsk: number; bidDepth: number; askDepth: number };
          down: { bestBid: number; bestAsk: number; bidDepth: number; askDepth: number };
          spreadBps: number;
          imbalance: number;
          liquidityScore: number;
        } | null;
      };
      if (json.ok && json.data) {
        return {
          upBid: json.data.up.bestBid,
          upAsk: json.data.up.bestAsk,
          downBid: json.data.down.bestBid,
          downAsk: json.data.down.bestAsk,
          spreadBps: json.data.spreadBps,
          depthScore: json.data.liquidityScore,
          imbalance: json.data.imbalance,
        };
      }
    } catch {
      // Fallback
    }
    return {
      upBid: 0,
      upAsk: 0,
      downBid: 0,
      downAsk: 0,
      spreadBps: 9999,
      depthScore: 0,
      imbalance: 0,
    };
  }

  private emitEvent(_event: string, _payload: Record<string, unknown>): void {
    /* noop */
  }
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface RawPriceData {
  startPrice: number;
  resolverPrice: number;
  deltaAbs: number;
  deltaPct: number;
  return5s: number;
  return15s: number;
  volatility: number;
}

interface RawBookData {
  upBid: number;
  upAsk: number;
  downBid: number;
  downAsk: number;
  spreadBps: number;
  depthScore: number;
  imbalance: number;
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function round(value: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
