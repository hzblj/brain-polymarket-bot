import { DATABASE_CLIENT, type DbClient, featureSnapshots } from '@brain/database';
import { type BrainEventName, type BrainEventMap, EventBus } from '@brain/events';
import type {
  BlockchainActivity,
  BookFeatures,
  FeaturePayload,
  MarketFeatures,
  PriceFeatures,
  SignalFeatures,
  WhaleFeatures,
} from '@brain/types';
import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { and, desc, gte, lte } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// Service base URLs (configurable via @brain/config)
// ---------------------------------------------------------------------------

const LOCAL_HOST = process.env.LOCAL_IP ?? 'localhost';
const MARKET_SERVICE_URL = process.env.MARKET_SERVICE_URL ?? `http://${LOCAL_HOST}:3001`;
const PRICE_SERVICE_URL = process.env.PRICE_SERVICE_URL ?? `http://${LOCAL_HOST}:3002`;
const BOOK_SERVICE_URL = process.env.BOOK_SERVICE_URL ?? `http://${LOCAL_HOST}:3003`;
const WHALE_SERVICE_URL = process.env.WHALE_SERVICE_URL ?? `http://${LOCAL_HOST}:3010`;
const DERIVATIVES_SERVICE_URL = process.env.DERIVATIVES_SERVICE_URL ?? `http://${LOCAL_HOST}:3013`;

const RECOMPUTE_INTERVAL_MS = 1_000;
const HISTORY_BUFFER_SIZE = 300;

// Tradeability thresholds (defaults, overridden from config-service)
const DEFAULT_MIN_TIME_TO_CLOSE_SEC = 15;
const DEFAULT_MIN_DEPTH_SCORE = 0.3;
const DEFAULT_MAX_SPREAD_BPS = 800;
const DEFAULT_MIN_VOLATILITY = 0.0001;

const CONFIG_SERVICE_URL = process.env.CONFIG_SERVICE_URL ?? `http://${LOCAL_HOST}:3007`;
const CONFIG_REFRESH_INTERVAL_MS = 30_000;

interface HistoryQuery {
  from: string;
  to: string;
}

interface TradeabilityThresholds {
  minTimeToCloseSec: number;
  minDepthScore: number;
  maxSpreadBps: number;
  minVolatility: number;
}

@Injectable()
export class FeatureEngineService implements OnModuleInit, OnModuleDestroy {
  private currentPayload: FeaturePayload | null = null;
  private payloadHistory: FeaturePayload[] = [];
  private computeTimer: ReturnType<typeof setInterval> | null = null;
  private configTimer: ReturnType<typeof setInterval> | null = null;
  private thresholds: TradeabilityThresholds = {
    minTimeToCloseSec: DEFAULT_MIN_TIME_TO_CLOSE_SEC,
    minDepthScore: DEFAULT_MIN_DEPTH_SCORE,
    maxSpreadBps: DEFAULT_MAX_SPREAD_BPS,
    minVolatility: DEFAULT_MIN_VOLATILITY,
  };

  constructor(
    @Inject(DATABASE_CLIENT) private readonly db: DbClient,
    @Inject(EventBus) private readonly eventBus: EventBus,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.refreshThresholds();
    await this.recompute();
    this.startComputeLoop();
    this.startConfigRefreshLoop();
  }

  onModuleDestroy(): void {
    this.stopComputeLoop();
    if (this.configTimer) {
      clearInterval(this.configTimer);
      this.configTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  getCurrentFeatures(): FeaturePayload | null {
    return this.currentPayload;
  }

  getWindowFeatures(): FeaturePayload | null {
    return this.currentPayload;
  }

  async getHistory(query: HistoryQuery): Promise<{ snapshots: FeaturePayload[]; count: number }> {
    const fromMs = new Date(query.from).getTime();
    const toMs = new Date(query.to).getTime();

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

    const filtered = this.payloadHistory.filter((p) => {
      return p.eventTime >= fromMs && p.eventTime <= toMs;
    });

    return { snapshots: filtered, count: filtered.length };
  }

  /**
   * Recomputes the full feature payload by fetching upstream service data
   * and running signal computations.
   */
  async recompute(): Promise<FeaturePayload> {
    const [marketData, priceData, bookData, whaleData, derivativesData, blockchainData] = await Promise.all([
      this.fetchMarketData(),
      this.fetchPriceData(),
      this.fetchBookData(),
      this.fetchWhaleData(),
      this.fetchDerivativesData(),
      this.fetchBlockchainActivity(),
    ]);

    const now = Date.now();

    // Build market features
    const market: MarketFeatures = {
      windowId: marketData.marketId,
      startPrice: priceData.startPrice,
      elapsedMs: marketData.startMs > 0 ? now - marketData.startMs : 0,
      remainingMs: marketData.secondsToClose * 1000,
    };

    // Build price features
    const polymarketMidPrice = (bookData.upBid + bookData.upAsk) / 2;
    const exchangeMidPrice = priceData.externalPrice || priceData.resolverPrice;

    const price: PriceFeatures = {
      currentPrice: priceData.resolverPrice,
      returnBps: round(priceData.deltaPct * 100, 2),
      volatility: priceData.volatility,
      momentum: priceData.momentumScore,
      meanReversionStrength: this.computeMeanReversionStrength(
        priceData.return5s,
        priceData.return15s,
        priceData.volatility,
      ),
      tickRate: priceData.tickRate,
      binancePrice: priceData.externalPrice,
      coinbasePrice: priceData.externalPrice, // single source for now
      exchangeMidPrice,
      polymarketMidPrice,
      basisBps: polymarketMidPrice > 0
        ? round((exchangeMidPrice / polymarketMidPrice - 1) * 10000, 1)
        : 0,
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
      bidDepthUsd: bookData.bidDepthUsd,
      askDepthUsd: bookData.askDepthUsd,
    };

    // Compute derived signals
    const signals = this.computeSignals(price, book, market);

    const payload: FeaturePayload = {
      windowId: market.windowId,
      eventTime: now,
      market,
      price,
      book,
      signals,
      ...(whaleData ? { whales: whaleData } : {}),
      ...(derivativesData ? { derivatives: derivativesData } : {}),
      ...(blockchainData ? { blockchain: blockchainData } : {}),
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
        windowId: payload.windowId,
        payload: payload as unknown as Record<string, unknown>,
        eventTime: payload.eventTime,
        processedAt: now,
      });
    } catch {
      /* ignore - feature snapshots are high-frequency */
    }

    // Emit event
    this.emitEvent('features.computed', {
      marketId: market.windowId,
      tradeable: signals.tradeable,
      timeToCloseSec: marketData.secondsToClose,
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

  private startConfigRefreshLoop(): void {
    this.configTimer = setInterval(async () => {
      try {
        await this.refreshThresholds();
      } catch {
        /* ignored - will retry on next interval */
      }
    }, CONFIG_REFRESH_INTERVAL_MS);
  }

  private async refreshThresholds(): Promise<void> {
    try {
      const res = await fetch(`${CONFIG_SERVICE_URL}/api/v1/config`, {
        signal: AbortSignal.timeout(3_000),
      });
      if (!res.ok) return;
      const json = (await res.json()) as {
        ok: boolean;
        data: { trading?: { maxSpreadBps?: number; minDepthScore?: number } } | null;
      };
      if (json.ok && json.data?.trading) {
        const t = json.data.trading;
        if (t.maxSpreadBps !== undefined) this.thresholds.maxSpreadBps = t.maxSpreadBps;
        if (t.minDepthScore !== undefined) this.thresholds.minDepthScore = t.minDepthScore;
      }
    } catch {
      /* config service unavailable — keep current thresholds */
    }
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

  private computeSignals(
    price: PriceFeatures,
    book: BookFeatures,
    market: MarketFeatures,
  ): SignalFeatures {
    const remainingSec = market.remainingMs / 1000;

    // Price direction: map momentum (0..1) to direction score (-1..1)
    const priceDirectionScore = round(Math.max(-1, Math.min(1, (price.momentum - 0.5) * 2)), 4);

    // Volatility regime classification
    const volatilityRegime: SignalFeatures['volatilityRegime'] =
      price.volatility < 0.001 ? 'low' : price.volatility > 0.01 ? 'high' : 'medium';

    // Book pressure classification from imbalance
    const bookPressure: SignalFeatures['bookPressure'] =
      book.imbalance > 0.15 ? 'bid' : book.imbalance < -0.15 ? 'ask' : 'neutral';

    // Basis signal: exchange vs polymarket divergence
    const basisSignal: SignalFeatures['basisSignal'] =
      price.basisBps > 50 ? 'long' : price.basisBps < -50 ? 'short' : 'neutral';

    // Tradeability check
    const tradeable = this.assessTradeability(remainingSec, book, price.volatility);

    return {
      priceDirectionScore,
      volatilityRegime,
      bookPressure,
      basisSignal,
      tradeable,
    };
  }

  /**
   * Computes mean reversion strength from short vs medium returns.
   * High when short return opposes medium return (price is reverting).
   */
  private computeMeanReversionStrength(
    return5s: number,
    return15s: number,
    volatility: number,
  ): number {
    if (volatility === 0) return 0;
    const signsDiffer = return5s * return15s < 0;
    if (!signsDiffer) return 0;
    const magnitude = Math.min(Math.abs(return5s / (volatility || 0.001)), 1);
    return round(magnitude, 4);
  }

  private assessTradeability(
    remainingSec: number,
    book: BookFeatures,
    volatility: number,
  ): boolean {
    if (remainingSec < this.thresholds.minTimeToCloseSec) return false;
    if (book.depthScore < this.thresholds.minDepthScore) return false;
    if (book.spreadBps > this.thresholds.maxSpreadBps) return false;
    if (volatility < this.thresholds.minVolatility) return false;
    return true;
  }

  // ---------------------------------------------------------------------------
  // Upstream data fetching
  // ---------------------------------------------------------------------------

  private async fetchMarketData(): Promise<RawMarketData> {
    try {
      const res = await fetch(`${MARKET_SERVICE_URL}/api/v1/market/window/current`);
      const json = (await res.json()) as {
        ok: boolean;
        data: { marketId: string; secondsToClose: number; start: string; end: string; isOpen: boolean } | null;
      };
      if (json.ok && json.data) {
        return {
          marketId: json.data.marketId,
          secondsToClose: json.data.secondsToClose,
          startMs: new Date(json.data.start).getTime(),
        };
      }
    } catch {
      // Fallback if service unavailable
    }
    return { marketId: 'btc-5m-unknown', secondsToClose: 0, startMs: 0 };
  }

  private async fetchPriceData(): Promise<RawPriceData> {
    try {
      const res = await fetch(`${PRICE_SERVICE_URL}/api/v1/price/current`);
      const json = (await res.json()) as {
        ok: boolean;
        data: {
          resolver: { price: number };
          external: { price: number };
          window: { startPrice: number; deltaAbs: number; deltaPct: number };
          micro: { return1s: number; return5s: number; return15s: number; momentumScore: number; volatility: number };
        } | null;
      };
      if (json.ok && json.data) {
        return {
          startPrice: json.data.window.startPrice,
          resolverPrice: json.data.resolver.price,
          externalPrice: json.data.external.price,
          deltaAbs: json.data.window.deltaAbs,
          deltaPct: json.data.window.deltaPct,
          return5s: json.data.micro.return5s,
          return15s: json.data.micro.return15s,
          volatility: json.data.micro.volatility,
          momentumScore: json.data.micro.momentumScore,
          tickRate: 0,
        };
      }
    } catch {
      // Fallback
    }
    return {
      startPrice: 0,
      resolverPrice: 0,
      externalPrice: 0,
      deltaAbs: 0,
      deltaPct: 0,
      return5s: 0,
      return15s: 0,
      volatility: 0,
      momentumScore: 0.5,
      tickRate: 0,
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
          bidDepthUsd: json.data.up.bidDepth + json.data.down.bidDepth,
          askDepthUsd: json.data.up.askDepth + json.data.down.askDepth,
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
      bidDepthUsd: 0,
      askDepthUsd: 0,
    };
  }

  private async fetchDerivativesData(): Promise<RawDerivativesData | null> {
    try {
      const res = await fetch(`${DERIVATIVES_SERVICE_URL}/api/v1/derivatives/current`);
      const json = (await res.json()) as { ok: boolean; data: RawDerivativesData | null };
      if (json.ok && json.data) return json.data;
    } catch {
      // Derivatives feed is optional
    }
    return null;
  }

  private async fetchWhaleData(): Promise<WhaleFeatures | null> {
    try {
      const res = await fetch(`${WHALE_SERVICE_URL}/api/v1/whales/current`);
      const json = (await res.json()) as {
        ok: boolean;
        data: WhaleFeatures | null;
      };
      if (json.ok && json.data) {
        return json.data;
      }
    } catch {
      // Whale tracker is optional — degrade gracefully
    }
    return null;
  }

  private async fetchBlockchainActivity(): Promise<BlockchainActivity | null> {
    try {
      const res = await fetch(`${WHALE_SERVICE_URL}/api/v1/whales/blockchain`);
      const json = (await res.json()) as { ok: boolean; data: BlockchainActivity | null };
      if (json.ok && json.data) return json.data;
    } catch {
      // Blockchain activity is optional
    }
    return null;
  }

  private emitEvent<E extends BrainEventName>(event: E, payload: BrainEventMap[E]): void {
    this.eventBus.emit(event, payload);
  }
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface RawMarketData {
  marketId: string;
  secondsToClose: number;
  startMs: number;
}

interface RawPriceData {
  startPrice: number;
  resolverPrice: number;
  externalPrice: number;
  deltaAbs: number;
  deltaPct: number;
  return5s: number;
  return15s: number;
  volatility: number;
  momentumScore: number;
  tickRate: number;
}

interface RawBookData {
  upBid: number;
  upAsk: number;
  downBid: number;
  downAsk: number;
  spreadBps: number;
  depthScore: number;
  imbalance: number;
  bidDepthUsd: number;
  askDepthUsd: number;
}

interface RawDerivativesData {
  fundingRate: number;
  fundingRateAnnualized: number;
  fundingPressure: number;
  openInterestUsd: number;
  openInterestChangePct: number;
  oiTrend: number;
  longLiquidationUsd: number;
  shortLiquidationUsd: number;
  liquidationImbalance: number;
  liquidationIntensity: number;
  derivativesSentiment: number;
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function round(value: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
