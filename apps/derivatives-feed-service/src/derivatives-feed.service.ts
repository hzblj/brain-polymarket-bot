import { DATABASE_CLIENT, type DbClient, derivativesSnapshots } from '@brain/database';
import { type BrainEventName, type BrainEventMap, EventBus } from '@brain/events';
import { BrainLoggerService } from '@brain/logger';
import type { DerivativesFeatures, LiquidationEvent } from '@brain/types';
import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { desc } from 'drizzle-orm';
import WebSocket from 'ws';

// ─── Constants ──────────────────────────────────────────────────────────────

const SYMBOL = 'BTCUSDT';

/** Binance Futures REST */
const BINANCE_FUTURES_API = 'https://fapi.binance.com';

/** Binance Futures WS — forceOrder stream for liquidations */
const BINANCE_FUTURES_WS = `wss://fstream.binance.com/ws/${SYMBOL.toLowerCase()}@forceOrder`;

/** How often to poll funding rate + OI (REST) */
const POLL_INTERVAL_MS = 15_000;

/** How often to persist snapshots to DB */
const PERSIST_INTERVAL_MS = 10_000;

/** Rolling window for liquidations (5 minutes) */
const LIQUIDATION_WINDOW_MS = 5 * 60 * 1000;

/** History buffer */
const HISTORY_BUFFER_SIZE = 300;

/** Reconnect backoff */
const BASE_RECONNECT_MS = 1_000;
const MAX_RECONNECT_MS = 30_000;

/** Extreme funding rate threshold (annualized >50% = extreme) */
const EXTREME_FUNDING_ANNUALIZED = 0.5;

/** Cascade alert threshold: >$5M liq in rolling window */
const CASCADE_THRESHOLD_USD = 5_000_000;

// ─── Service ────────────────────────────────────────────────────────────────

@Injectable()
export class DerivativesFeedService implements OnModuleInit, OnModuleDestroy {
  private readonly logger: BrainLoggerService;
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private persistTimer: ReturnType<typeof setInterval> | null = null;

  /** Latest funding rate data */
  private fundingRate = 0;
  private fundingTime = 0;
  private markPrice = 0;

  /** Open interest tracking */
  private currentOiUsd = 0;
  private previousOiUsd = 0;
  private oiHistory: Array<{ usd: number; time: number }> = [];

  /** Rolling window of liquidation events */
  private recentLiquidations: LiquidationEvent[] = [];

  /** Baseline liquidation volume (EMA) for intensity score */
  private baselineLiqUsd = 0;
  private baselineSampleCount = 0;

  /** Computed features */
  private currentFeatures: DerivativesFeatures = this.defaultFeatures();

  /** History buffer */
  private snapshotHistory: Array<{ features: DerivativesFeatures; eventTime: number }> = [];

  constructor(
    @Inject(DATABASE_CLIENT) private readonly db: DbClient,
    @Inject(EventBus) private readonly eventBus: EventBus,
    @Inject(BrainLoggerService) logger: BrainLoggerService,
  ) {
    this.logger = logger.child('DerivativesFeedService');
  }

  async onModuleInit(): Promise<void> {
    await this.pollRestData();
    this.connectLiquidationStream();
    this.startPollLoop();
    this.startPersistLoop();
  }

  onModuleDestroy(): void {
    this.disconnectWs();
    this.stopPollLoop();
    this.stopPersistLoop();
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  getCurrentFeatures(): DerivativesFeatures {
    return this.currentFeatures;
  }

  getRecentLiquidations(limit = 20): LiquidationEvent[] {
    return this.recentLiquidations.slice(-limit);
  }

  getHistory(limit = 50): Array<{ features: DerivativesFeatures; eventTime: number }> {
    return this.snapshotHistory.slice(-limit);
  }

  getStatus(): {
    wsConnected: boolean;
    fundingRate: number;
    openInterestUsd: number;
    liquidationCount: number;
  } {
    return {
      wsConnected: this.ws?.readyState === WebSocket.OPEN,
      fundingRate: this.fundingRate,
      openInterestUsd: this.currentOiUsd,
      liquidationCount: this.recentLiquidations.length,
    };
  }

  // ─── Liquidation WebSocket (real-time) ────────────────────────────────────

  private connectLiquidationStream(): void {
    this.logger.info('Connecting to Binance Futures liquidation stream');

    try {
      this.ws = new WebSocket(BINANCE_FUTURES_WS);
    } catch (err) {
      this.logger.error('Failed to create WS', (err as Error).message);
      this.scheduleReconnect();
      return;
    }

    this.ws.on('open', () => {
      this.logger.info('Connected to Binance Futures liquidation stream');
      this.reconnectAttempts = 0;
    });

    this.ws.on('message', (data: WebSocket.Data) => {
      try {
        this.handleLiquidation(data.toString());
      } catch (err) {
        this.logger.debug('Failed to parse liquidation', { error: (err as Error).message });
      }
    });

    this.ws.on('close', () => {
      this.logger.warn('Liquidation stream disconnected');
      this.scheduleReconnect();
    });

    this.ws.on('error', (err: Error) => {
      this.logger.error('Liquidation WS error', err.message);
    });
  }

  private disconnectWs(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
  }

  private scheduleReconnect(): void {
    this.reconnectAttempts++;
    const delay = Math.min(BASE_RECONNECT_MS * 2 ** (this.reconnectAttempts - 1), MAX_RECONNECT_MS);
    this.reconnectTimer = setTimeout(() => this.connectLiquidationStream(), delay);
  }

  private handleLiquidation(raw: string): void {
    const msg = JSON.parse(raw) as BinanceForceOrderMsg;
    const order = msg.o;
    if (!order) return;

    const quantity = parseFloat(order.q);
    const price = parseFloat(order.p);
    const quantityUsd = quantity * price;

    // Only track significant liquidations (>$10k)
    if (quantityUsd < 10_000) return;

    const liq: LiquidationEvent = {
      symbol: order.s,
      side: order.S === 'BUY' ? 'buy' : 'sell',
      price,
      quantity,
      quantityUsd,
      eventTime: order.T,
    };

    this.recentLiquidations.push(liq);
    this.pruneOldLiquidations();
    this.recomputeFeatures();

    this.emitEvent('derivatives.liquidation.detected', {
      side: liq.side,
      quantityUsd: liq.quantityUsd,
      price: liq.price,
    });

    // Check for liquidation cascade
    const totalLiqUsd = this.recentLiquidations.reduce((s, l) => s + l.quantityUsd, 0);
    if (totalLiqUsd > CASCADE_THRESHOLD_USD) {
      const dominantSide = this.currentFeatures.liquidationImbalance > 0 ? 'long' : 'short';
      this.emitEvent('derivatives.cascade.alert', {
        liquidationIntensity: this.currentFeatures.liquidationIntensity,
        side: dominantSide,
        totalUsd: totalLiqUsd,
      });
    }

    this.logger.info('Liquidation detected', {
      side: liq.side,
      quantityUsd: Math.round(liq.quantityUsd),
      price: liq.price,
    });
  }

  // ─── REST Polling (funding rate + open interest) ──────────────────────────

  private async pollRestData(): Promise<void> {
    await Promise.all([this.fetchFundingRate(), this.fetchOpenInterest()]);
    this.recomputeFeatures();
  }

  private async fetchFundingRate(): Promise<void> {
    try {
      const res = await fetch(
        `${BINANCE_FUTURES_API}/fapi/v1/premiumIndex?symbol=${SYMBOL}`,
      );
      const data = (await res.json()) as {
        lastFundingRate: string;
        nextFundingTime: number;
        markPrice: string;
        indexPrice: string;
      };

      this.fundingRate = parseFloat(data.lastFundingRate);
      this.fundingTime = data.nextFundingTime;
      this.markPrice = parseFloat(data.markPrice);

      this.emitEvent('derivatives.funding.updated', {
        fundingRate: this.fundingRate,
        fundingPressure: this.computeFundingPressure(),
      });

      this.logger.debug('Funding rate updated', {
        rate: this.fundingRate,
        annualized: (this.fundingRate * 3 * 365 * 100).toFixed(2) + '%',
      });
    } catch (err) {
      this.logger.error('Failed to fetch funding rate', (err as Error).message);
    }
  }

  private async fetchOpenInterest(): Promise<void> {
    try {
      const res = await fetch(
        `${BINANCE_FUTURES_API}/fapi/v1/openInterest?symbol=${SYMBOL}`,
      );
      const data = (await res.json()) as { openInterest: string };

      const oiBtc = parseFloat(data.openInterest);
      const oiUsd = oiBtc * this.markPrice;

      this.previousOiUsd = this.currentOiUsd || oiUsd;
      this.currentOiUsd = oiUsd;

      // Track OI history for trend computation
      this.oiHistory.push({ usd: oiUsd, time: Date.now() });
      if (this.oiHistory.length > 60) {
        this.oiHistory = this.oiHistory.slice(-60);
      }

      const changePct =
        this.previousOiUsd > 0
          ? ((oiUsd - this.previousOiUsd) / this.previousOiUsd) * 100
          : 0;

      this.emitEvent('derivatives.oi.changed', {
        openInterestUsd: oiUsd,
        changePct,
      });
    } catch (err) {
      this.logger.error('Failed to fetch open interest', (err as Error).message);
    }
  }

  // ─── Feature Computation ──────────────────────────────────────────────────

  private recomputeFeatures(): void {
    const fundingPressure = this.computeFundingPressure();
    const fundingRateAnnualized = this.fundingRate * 3 * 365;

    // OI change
    const oiChangePct =
      this.previousOiUsd > 0
        ? ((this.currentOiUsd - this.previousOiUsd) / this.previousOiUsd) * 100
        : 0;

    // OI trend: use recent history to detect sustained changes
    const oiTrend = this.computeOiTrend();

    // Liquidation metrics
    const liqs = this.recentLiquidations;
    let longLiqUsd = 0;
    let shortLiqUsd = 0;
    for (const l of liqs) {
      // When a SELL liquidation happens, a LONG position was liquidated
      if (l.side === 'sell') longLiqUsd += l.quantityUsd;
      else shortLiqUsd += l.quantityUsd;
    }

    const totalLiqUsd = longLiqUsd + shortLiqUsd;

    // Liquidation imbalance: positive = more longs liquidated (bearish)
    const liquidationImbalance =
      totalLiqUsd > 0 ? (longLiqUsd - shortLiqUsd) / totalLiqUsd : 0;

    // Liquidation intensity vs baseline
    this.updateLiqBaseline(totalLiqUsd);
    const liquidationIntensity =
      this.baselineLiqUsd > 0
        ? Math.min(1, totalLiqUsd / (this.baselineLiqUsd * 5))
        : totalLiqUsd > 0
          ? 0.5
          : 0;

    // Composite sentiment: combines all three signals
    // Funding: negative funding = bullish (+1), positive = bearish (-1)
    // OI trend: rising OI with stable price = building, falling = unwinding
    // Liquidation imbalance: more longs liquidated = bearish
    const fundingSignal = -fundingPressure; // Flip: negative funding = bullish
    const liqSignal = -liquidationImbalance * liquidationIntensity;
    const derivativesSentiment = clamp(
      fundingSignal * 0.3 + oiTrend * 0.3 + liqSignal * 0.4,
      -1,
      1,
    );

    this.currentFeatures = {
      fundingRate: round(this.fundingRate, 6),
      fundingRateAnnualized: round(fundingRateAnnualized, 4),
      fundingPressure: round(fundingPressure, 4),
      openInterestUsd: round(this.currentOiUsd, 0),
      openInterestChangePct: round(oiChangePct, 4),
      oiTrend: round(oiTrend, 4),
      longLiquidationUsd: round(longLiqUsd, 0),
      shortLiquidationUsd: round(shortLiqUsd, 0),
      liquidationImbalance: round(liquidationImbalance, 4),
      liquidationIntensity: round(liquidationIntensity, 4),
      derivativesSentiment: round(derivativesSentiment, 4),
    };
  }

  private computeFundingPressure(): number {
    // Normalize funding rate to -1..1 scale
    // Typical funding: 0.01% (neutral), extreme: >0.1% or <-0.05%
    // Annualized: neutral ~10%, extreme >50%
    const annualized = this.fundingRate * 3 * 365;
    return clamp(annualized / EXTREME_FUNDING_ANNUALIZED, -1, 1);
  }

  private computeOiTrend(): number {
    if (this.oiHistory.length < 3) return 0;

    const recent = this.oiHistory.slice(-5);
    const oldest = recent[0];
    const newest = recent[recent.length - 1];

    if (!oldest || !newest || oldest.usd === 0) return 0;

    const changePct = ((newest.usd - oldest.usd) / oldest.usd) * 100;
    // Normalize: 5% change in 5 minutes = full signal
    return clamp(changePct / 5, -1, 1);
  }

  private updateLiqBaseline(current: number): void {
    this.baselineSampleCount++;
    const alpha = Math.min(0.05, 2 / (this.baselineSampleCount + 1));
    this.baselineLiqUsd = this.baselineLiqUsd * (1 - alpha) + current * alpha;
  }

  private pruneOldLiquidations(): void {
    const cutoff = Date.now() - LIQUIDATION_WINDOW_MS;
    this.recentLiquidations = this.recentLiquidations.filter((l) => l.eventTime > cutoff);
  }

  private defaultFeatures(): DerivativesFeatures {
    return {
      fundingRate: 0,
      fundingRateAnnualized: 0,
      fundingPressure: 0,
      openInterestUsd: 0,
      openInterestChangePct: 0,
      oiTrend: 0,
      longLiquidationUsd: 0,
      shortLiquidationUsd: 0,
      liquidationImbalance: 0,
      liquidationIntensity: 0,
      derivativesSentiment: 0,
    };
  }

  // ─── Polling / Persistence ────────────────────────────────────────────────

  private startPollLoop(): void {
    this.pollTimer = setInterval(async () => {
      await this.pollRestData();
    }, POLL_INTERVAL_MS);
  }

  private stopPollLoop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private startPersistLoop(): void {
    this.persistTimer = setInterval(async () => {
      this.pruneOldLiquidations();
      this.recomputeFeatures();
      await this.persistSnapshot();
    }, PERSIST_INTERVAL_MS);
  }

  private stopPersistLoop(): void {
    if (this.persistTimer) {
      clearInterval(this.persistTimer);
      this.persistTimer = null;
    }
  }

  private async persistSnapshot(): Promise<void> {
    const now = Date.now();
    const f = this.currentFeatures;

    this.snapshotHistory.push({ features: f, eventTime: now });
    if (this.snapshotHistory.length > HISTORY_BUFFER_SIZE) {
      this.snapshotHistory = this.snapshotHistory.slice(-HISTORY_BUFFER_SIZE);
    }

    try {
      await this.db.insert(derivativesSnapshots).values({
        windowId: 'rolling',
        fundingRate: f.fundingRate,
        fundingPressure: f.fundingPressure,
        openInterestUsd: f.openInterestUsd,
        openInterestChangePct: f.openInterestChangePct,
        oiTrend: f.oiTrend,
        longLiquidationUsd: f.longLiquidationUsd,
        shortLiquidationUsd: f.shortLiquidationUsd,
        liquidationImbalance: f.liquidationImbalance,
        liquidationIntensity: f.liquidationIntensity,
        derivativesSentiment: f.derivativesSentiment,
        eventTime: now,
        ingestedAt: now,
      });
    } catch {
      /* best-effort */
    }
  }

  async getPersistedHistory(limit = 50): Promise<Array<Record<string, unknown>>> {
    return this.db
      .select()
      .from(derivativesSnapshots)
      .orderBy(desc(derivativesSnapshots.eventTime))
      .limit(limit);
  }

  // ─── Utilities ────────────────────────────────────────────────────────────

  private emitEvent<E extends BrainEventName>(event: E, payload: BrainEventMap[E]): void {
    this.eventBus.emit(event, payload);
  }
}

// ─── Binance WS Types ───────────────────────────────────────────────────────

interface BinanceForceOrderMsg {
  e: 'forceOrder';
  E: number;
  o: {
    s: string; // Symbol
    S: 'BUY' | 'SELL'; // Side
    o: string; // Order type
    f: string; // Time in force
    q: string; // Original quantity
    p: string; // Price
    ap: string; // Average price
    X: string; // Order status
    l: string; // Last filled quantity
    z: string; // Filled accumulated quantity
    T: number; // Trade time
  };
}

// ─── Utility ────────────────────────────────────────────────────────────────

function round(value: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
