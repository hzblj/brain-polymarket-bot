import { DATABASE_CLIENT, type DbClient, featureSnapshots } from '@brain/database';
import { type BrainEventName, type BrainEventMap, EventBus } from '@brain/events';
import type {
  BlockchainActivity,
  BookFeatures,
  FeaturePayload,
  MarketFeatures,
  PriceFeatures,
  SignalFeatures,
  SweepFeatures,
  TopWallet,
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
const LAG_BUFFER_SIZE = 60; // 60s of samples for cross-correlation
const MAX_LAG_OFFSET = 10; // test lags 0-10s

// Sweep detection constants
const SWING_LOOKBACK = 30; // seconds to look back for swing points
const SWING_MIN_PROMINENCE_BPS = 5; // minimum swing prominence in bps
const SWEEP_PIERCE_THRESHOLD_BPS = 3; // minimum pierce beyond swing level
const SWEEP_REVERT_THRESHOLD_BPS = 2; // minimum revert back from pierce
const SWEEP_MAX_AGE_MS = 30_000; // sweep signal expires after 30s
const PRICE_BUFFER_SIZE = 120; // 2 minutes of 1s price samples

// Tradeability thresholds (defaults, overridden from config-service)
const DEFAULT_MIN_TIME_TO_CLOSE_SEC = 15;
const DEFAULT_MIN_DEPTH_SCORE = 0.3;
const DEFAULT_MAX_SPREAD_BPS = 800;
const DEFAULT_MIN_VOLATILITY = 0;

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

  /** Rolling buffer for lag cross-correlation: {ts, binancePrice, polyMidPrice} */
  private lagBuffer: { ts: number; binancePrice: number; polyMidPrice: number }[] = [];

  /** Rolling buffer of 1s price samples for swing/sweep detection */
  private priceBuffer: { ts: number; price: number }[] = [];

  /** Active sweep detection state */
  private activeSweep: {
    detectedAt: number;
    direction: 'up' | 'down';
    sweptLevel: number;
    pierceBps: number;
    revertBps: number;
    volumeZScore: number;
  } | null = null;
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
    const [marketData, priceData, bookData, whaleData, derivativesData, blockchainData, topWallets, whaleLlmSummary] = await Promise.all([
      this.fetchMarketData(),
      this.fetchPriceData(),
      this.fetchBookData(),
      this.fetchWhaleData(),
      this.fetchDerivativesData(),
      this.fetchBlockchainActivity(),
      this.fetchTopWallets(),
      this.fetchWhaleLlmSummary(),
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

    // Track lag between Binance and Polymarket
    this.pushLagSample(now, priceData.externalPrice, polymarketMidPrice);
    const lag = this.computeLag();

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
      lagMs: lag.lagMs,
      predictiveBasisBps: lag.predictiveBasisBps,
      lagReliability: lag.lagReliability,
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

    // Sweep detection (Phase 1 + 2 + 3)
    this.pushPriceSample(now, priceData.externalPrice);
    this.detectSweep(priceData.externalPrice, priceData.volumeZScore);
    const sweep = this.buildSweepFeatures(book.imbalance, price.lagMs, price.predictiveBasisBps, price.lagReliability);

    const payload: FeaturePayload = {
      windowId: market.windowId,
      eventTime: now,
      market,
      price,
      book,
      signals,
      sweep,
      ...(whaleData ? { whales: whaleData } : {}),
      ...(topWallets && topWallets.length > 0 ? { topWallets } : {}),
      ...(whaleLlmSummary ? { whaleLlmSummary } : {}),
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
        const t = json.data.trading as Record<string, unknown>;
        if (t.maxSpreadBps !== undefined) this.thresholds.maxSpreadBps = t.maxSpreadBps as number;
        if (t.minDepthScore !== undefined) this.thresholds.minDepthScore = t.minDepthScore as number;
        if (t.minVolatility !== undefined) this.thresholds.minVolatility = t.minVolatility as number;
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

    // Lag signal: is Polymarket stale relative to Binance?
    const lagSignal: SignalFeatures['lagSignal'] =
      price.lagReliability > 0.3 && Math.abs(price.predictiveBasisBps) > 20
        ? price.predictiveBasisBps > 0 ? 'stale_up' : 'stale_down'
        : 'synced';

    // Tradeability check
    const tradeable = this.assessTradeability(remainingSec, book, price.volatility);

    return {
      priceDirectionScore,
      volatilityRegime,
      bookPressure,
      basisSignal,
      lagSignal,
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
  // Sweep detection: swing tracker + pierce/revert detection + volume + lag
  // ---------------------------------------------------------------------------

  private pushPriceSample(ts: number, price: number): void {
    if (price <= 0) return;
    this.priceBuffer.push({ ts, price });
    if (this.priceBuffer.length > PRICE_BUFFER_SIZE) {
      this.priceBuffer = this.priceBuffer.slice(-PRICE_BUFFER_SIZE);
    }
  }

  /**
   * Find swing highs and lows from the price buffer.
   * A swing high has lower prices on both sides; a swing low has higher prices.
   */
  private findSwingLevels(): { highs: number[]; lows: number[] } {
    const buf = this.priceBuffer;
    if (buf.length < 5) return { highs: [], lows: [] };

    const cutoff = Date.now() - SWING_LOOKBACK * 1000;
    const recent = buf.filter(s => s.ts >= cutoff);
    if (recent.length < 5) return { highs: [], lows: [] };

    const highs: number[] = [];
    const lows: number[] = [];

    // Use a simple pivot detection: point i is a pivot if it's the highest/lowest
    // in a window of ±3 samples
    const window = 3;
    for (let i = window; i < recent.length - window; i++) {
      const p = recent[i]!.price;
      let isHigh = true;
      let isLow = true;

      for (let j = i - window; j <= i + window; j++) {
        if (j === i) continue;
        const other = recent[j]!.price;
        if (other >= p) isHigh = false;
        if (other <= p) isLow = false;
      }

      // Check prominence: must be at least X bps above/below neighbors
      if (isHigh) {
        const left = recent[i - window]!.price;
        const right = recent[i + window]!.price;
        const prominence = ((p - Math.max(left, right)) / p) * 10000;
        if (prominence >= SWING_MIN_PROMINENCE_BPS) highs.push(p);
      }
      if (isLow) {
        const left = recent[i - window]!.price;
        const right = recent[i + window]!.price;
        const prominence = ((Math.min(left, right) - p) / p) * 10000;
        if (prominence >= SWING_MIN_PROMINENCE_BPS) lows.push(p);
      }
    }

    return { highs, lows };
  }

  /**
   * Detect if current price action constitutes a liquidity sweep:
   * 1. Price pierces beyond a swing level
   * 2. Then reverts back inside
   */
  private detectSweep(currentPrice: number, volumeZScore: number): void {
    if (currentPrice <= 0) return;

    const now = Date.now();

    // Expire old sweep
    if (this.activeSweep && (now - this.activeSweep.detectedAt) > SWEEP_MAX_AGE_MS) {
      this.activeSweep = null;
    }

    const { highs, lows } = this.findSwingLevels();

    // Check for bearish sweep: price pierced above a swing high, now reverting down
    for (const high of highs) {
      const pierceBps = ((currentPrice - high) / high) * 10000;

      // Price was above the high (or just came back from above)
      if (pierceBps > SWEEP_PIERCE_THRESHOLD_BPS) {
        // Price is still above — potential sweep in progress, wait for revert
        continue;
      }

      // Check recent history: did we recently pierce above this level?
      const recentMax = this.getRecentMax(5);
      const recentPierce = ((recentMax - high) / high) * 10000;

      if (recentPierce >= SWEEP_PIERCE_THRESHOLD_BPS) {
        // We pierced above and now current price is back at/below the level
        const revertBps = ((recentMax - currentPrice) / currentPrice) * 10000;

        if (revertBps >= SWEEP_REVERT_THRESHOLD_BPS) {
          // Bearish sweep detected: swept high, reverting down → expect DOWN
          if (!this.activeSweep || this.activeSweep.revertBps < revertBps) {
            this.activeSweep = {
              detectedAt: now,
              direction: 'down',
              sweptLevel: high,
              pierceBps: round(recentPierce, 1),
              revertBps: round(revertBps, 1),
              volumeZScore,
            };
          }
        }
      }
    }

    // Check for bullish sweep: price pierced below a swing low, now reverting up
    for (const low of lows) {
      const pierceBps = ((low - currentPrice) / low) * 10000;

      if (pierceBps > SWEEP_PIERCE_THRESHOLD_BPS) {
        continue; // still below — wait for revert
      }

      const recentMin = this.getRecentMin(5);
      const recentPierce = ((low - recentMin) / low) * 10000;

      if (recentPierce >= SWEEP_PIERCE_THRESHOLD_BPS) {
        const revertBps = ((currentPrice - recentMin) / recentMin) * 10000;

        if (revertBps >= SWEEP_REVERT_THRESHOLD_BPS) {
          // Bullish sweep detected: swept low, reverting up → expect UP
          if (!this.activeSweep || this.activeSweep.revertBps < revertBps) {
            this.activeSweep = {
              detectedAt: now,
              direction: 'up',
              sweptLevel: low,
              pierceBps: round(recentPierce, 1),
              revertBps: round(revertBps, 1),
              volumeZScore,
            };
          }
        }
      }
    }
  }

  private getRecentMax(seconds: number): number {
    const cutoff = Date.now() - seconds * 1000;
    let max = 0;
    for (const s of this.priceBuffer) {
      if (s.ts >= cutoff && s.price > max) max = s.price;
    }
    return max;
  }

  private getRecentMin(seconds: number): number {
    const cutoff = Date.now() - seconds * 1000;
    let min = Infinity;
    for (const s of this.priceBuffer) {
      if (s.ts >= cutoff && s.price < min) min = s.price;
    }
    return min === Infinity ? 0 : min;
  }

  /**
   * Build the SweepFeatures payload from active sweep state + confirmations.
   * Phase 3: integrates lag tracker and orderbook data.
   */
  private buildSweepFeatures(
    bookImbalance: number,
    lagMs: number,
    predictiveBasisBps: number,
    lagReliability: number,
  ): SweepFeatures {
    const { highs, lows } = this.findSwingLevels();

    if (!this.activeSweep) {
      return {
        sweepDetected: false,
        sweepDirection: 'none',
        pierceBps: 0,
        revertBps: 0,
        sweepConfidence: 0,
        sweepAgeMs: 0,
        volumeZScore: 0,
        bookConfirmed: false,
        lagConfirmed: false,
        sweptLevel: 0,
        swingLevelCount: highs.length + lows.length,
      };
    }

    const s = this.activeSweep;
    const age = Date.now() - s.detectedAt;

    // Phase 2: volume confirmation
    const volumeConfirmed = s.volumeZScore >= 1.5;

    // Phase 3: book confirmation — imbalance should flip to support reversal
    // Bullish sweep (expect up): imbalance should be positive (bid pressure)
    // Bearish sweep (expect down): imbalance should be negative (ask pressure)
    const bookConfirmed =
      (s.direction === 'up' && bookImbalance > 0.1) ||
      (s.direction === 'down' && bookImbalance < -0.1);

    // Phase 3: lag confirmation — Poly hasn't priced in the reversal yet
    const lagConfirmed = lagReliability > 0.3 && lagMs > 1000 && (
      (s.direction === 'up' && predictiveBasisBps > 15) ||
      (s.direction === 'down' && predictiveBasisBps < -15)
    );

    // Composite confidence
    let confidence = 0.3; // base for detected sweep
    if (s.pierceBps > 5) confidence += 0.1;
    if (s.revertBps > 5) confidence += 0.1;
    if (volumeConfirmed) confidence += 0.15;
    if (bookConfirmed) confidence += 0.1;
    if (lagConfirmed) confidence += 0.15;
    if (age < 5000) confidence += 0.05; // fresh sweep
    confidence = round(Math.min(1, confidence), 2);

    return {
      sweepDetected: true,
      sweepDirection: s.direction,
      pierceBps: s.pierceBps,
      revertBps: s.revertBps,
      sweepConfidence: confidence,
      sweepAgeMs: age,
      volumeZScore: s.volumeZScore,
      bookConfirmed,
      lagConfirmed,
      sweptLevel: round(s.sweptLevel, 2),
      swingLevelCount: highs.length + lows.length,
    };
  }

  // ---------------------------------------------------------------------------
  // Lag tracking: cross-correlate Binance vs Polymarket price changes
  // ---------------------------------------------------------------------------

  private pushLagSample(ts: number, binancePrice: number, polyMidPrice: number): void {
    if (binancePrice <= 0 || polyMidPrice <= 0) return;
    this.lagBuffer.push({ ts, binancePrice, polyMidPrice });
    if (this.lagBuffer.length > LAG_BUFFER_SIZE) {
      this.lagBuffer = this.lagBuffer.slice(-LAG_BUFFER_SIZE);
    }
  }

  /**
   * Cross-correlate 1s Binance returns with Polymarket returns at different
   * time offsets to estimate how many seconds Poly lags behind Binance.
   * Also computes the "predictive basis" — Binance move not yet priced in.
   */
  private computeLag(): { lagMs: number; predictiveBasisBps: number; lagReliability: number } {
    const buf = this.lagBuffer;
    if (buf.length < 10) return { lagMs: 0, predictiveBasisBps: 0, lagReliability: 0 };

    // Compute 1s returns for both series
    const binanceReturns: number[] = [];
    const polyReturns: number[] = [];
    for (let i = 1; i < buf.length; i++) {
      const prev = buf[i - 1]!;
      const curr = buf[i]!;
      binanceReturns.push((curr.binancePrice - prev.binancePrice) / prev.binancePrice);
      polyReturns.push((curr.polyMidPrice - prev.polyMidPrice) / prev.polyMidPrice);
    }

    // Cross-correlate at offsets 0..MAX_LAG_OFFSET
    let bestCorr = -Infinity;
    let bestLag = 0;

    for (let offset = 0; offset <= Math.min(MAX_LAG_OFFSET, binanceReturns.length - 5); offset++) {
      const n = binanceReturns.length - offset;
      if (n < 5) break;

      let sumXY = 0;
      let sumX2 = 0;
      let sumY2 = 0;
      for (let i = 0; i < n; i++) {
        const x = binanceReturns[i]!;
        const y = polyReturns[i + offset]!;
        sumXY += x * y;
        sumX2 += x * x;
        sumY2 += y * y;
      }

      const denom = Math.sqrt(sumX2 * sumY2);
      const corr = denom > 0 ? sumXY / denom : 0;
      if (corr > bestCorr) {
        bestCorr = corr;
        bestLag = offset;
      }
    }

    // Reliability: how much better is the best-lag correlation vs zero-lag
    const zeroCorr = this.computeCorrelationAtOffset(binanceReturns, polyReturns, 0);
    const lagReliability = bestLag > 0 && bestCorr > 0
      ? round(Math.min(1, Math.max(0, (bestCorr - Math.max(zeroCorr, 0)) * 5)), 2)
      : 0;

    // Predictive basis: sum of Binance returns over the last `bestLag` seconds
    // that Poly hasn't caught up to yet
    let predictiveBasisBps = 0;
    if (bestLag > 0 && buf.length > bestLag) {
      const recentBinance = buf[buf.length - 1]!.binancePrice;
      const laggedBinance = buf[buf.length - 1 - bestLag]!.binancePrice;
      const currentPoly = buf[buf.length - 1]!.polyMidPrice;

      if (laggedBinance > 0 && currentPoly > 0) {
        // How much Binance moved in the lag window
        const binanceMoveBps = ((recentBinance - laggedBinance) / laggedBinance) * 10000;
        // How much Poly has priced in (compare to lagged Binance)
        const polyPricedBps = ((currentPoly - laggedBinance) / laggedBinance) * 10000;
        predictiveBasisBps = round(binanceMoveBps - polyPricedBps, 1);
      }
    }

    return {
      lagMs: bestLag * 1000,
      predictiveBasisBps,
      lagReliability,
    };
  }

  private computeCorrelationAtOffset(xs: number[], ys: number[], offset: number): number {
    const n = xs.length - offset;
    if (n < 5) return 0;
    let sumXY = 0;
    let sumX2 = 0;
    let sumY2 = 0;
    for (let i = 0; i < n; i++) {
      const x = xs[i]!;
      const y = ys[i + offset]!;
      sumXY += x * y;
      sumX2 += x * x;
      sumY2 += y * y;
    }
    const denom = Math.sqrt(sumX2 * sumY2);
    return denom > 0 ? sumXY / denom : 0;
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
          volume?: { volume1s: number; volumeMean: number; volumeStd: number; volumeZScore: number; buyRatio: number };
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
          volumeZScore: json.data.volume?.volumeZScore ?? 0,
          buyRatio: json.data.volume?.buyRatio ?? 0.5,
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
      volumeZScore: 0,
      buyRatio: 0.5,
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

  private async fetchTopWallets(): Promise<TopWallet[] | null> {
    try {
      const res = await fetch(`${WHALE_SERVICE_URL}/api/v1/whales/top-wallets?limit=10`);
      const json = (await res.json()) as { ok: boolean; data: TopWallet[] | null };
      if (json.ok && json.data) return json.data;
    } catch {
      // Top wallets is optional
    }
    return null;
  }

  private async fetchWhaleLlmSummary(): Promise<string | null> {
    try {
      const res = await fetch(`${WHALE_SERVICE_URL}/api/v1/whales/llm-summary`);
      const json = (await res.json()) as { ok: boolean; data: string | null };
      if (json.ok && json.data) return json.data;
    } catch {
      // LLM summary is optional
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
  volumeZScore: number;
  buyRatio: number;
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
