import { DATABASE_CLIENT, type DbClient, priceTicks } from '@brain/database';
import { type BrainEventName, type BrainEventMap, EventBus } from '@brain/events';
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { and, asc, desc, eq, gte, lte } from 'drizzle-orm';
import WebSocket from 'ws';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BinanceBookTickerMessage {
  e: string; // event type
  E: number; // event time
  s: string; // symbol
  b: string; // best bid price
  B: string; // best bid qty
  a: string; // best ask price
  A: string; // best ask qty
}

interface PriceTick {
  price: number;
  timestamp: string;
  source: 'resolver' | 'external';
  bid?: number;
  ask?: number;
}

interface ResolverPrice {
  price: number;
  timestamp: string;
}

interface ExternalPrice {
  price: number;
  bid: number;
  ask: number;
  timestamp: string;
}

interface WindowData {
  startPrice: number;
  deltaAbs: number;
  deltaPct: number;
  timeToCloseSec: number;
}

interface MicroSignals {
  return1s: number;
  return5s: number;
  return15s: number;
  momentumScore: number;
  volatility: number;
}

interface CurrentPricePayload {
  resolver: ResolverPrice;
  external: ExternalPrice;
  window: WindowData;
  micro: MicroSignals;
}

interface HistoryQuery {
  from: string;
  to: string;
  source: string;
  interval: string;
}

interface WindowResetResult {
  startPrice: number;
  resetAt: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TICK_POLL_MS = 1_000;
const BUFFER_MAX_SIZE = 300; // 5 minutes of 1s ticks
const WINDOW_DURATION_SEC = 300;
const WS_STALE_THRESHOLD_MS = 3_000;
const MAX_RECONNECT_ATTEMPTS = 20;
const BASE_RECONNECT_MS = 1_000;

@Injectable()
export class PriceFeedService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PriceFeedService.name);

  /** Rolling buffer of recent ticks (newest last). */
  private tickBuffer: PriceTick[] = [];

  /** Latest prices by source. */
  private latestResolver: ResolverPrice | null = null;
  private latestExternal: ExternalPrice | null = null;

  /** Start price for the current 5-minute window. */
  private windowStartPrice: number | null = null;
  private windowStartTime: number | null = null;

  private pollTimer: ReturnType<typeof setInterval> | null = null;

  /** Binance WebSocket state. */
  private ws: WebSocket | null = null;
  private lastTickTime = 0;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldReconnect = true;

  private readonly wsBaseUrl: string;
  private readonly symbol: string;

  constructor(
    @Inject(DATABASE_CLIENT) private readonly db: DbClient,
    @Inject(EventBus) private readonly eventBus: EventBus,
  ) {
    this.wsBaseUrl = process.env.BINANCE_WS_URL ?? 'wss://stream.binance.com:9443/ws';
    this.symbol = (process.env.PRICE_FEED_SYMBOL ?? 'btcusdt').toLowerCase();
  }

  async onModuleInit(): Promise<void> {
    await this.resetWindow();
    this.connectBinanceWs();
    this.startTickPolling();
  }

  onModuleDestroy(): void {
    this.stopTickPolling();
    this.disconnectBinanceWs();
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  getCurrentPrice(): CurrentPricePayload {
    const resolver = this.latestResolver ?? { price: 0, timestamp: new Date().toISOString() };
    const external = this.latestExternal ?? {
      price: 0,
      bid: 0,
      ask: 0,
      timestamp: new Date().toISOString(),
    };
    const window = this.computeWindowData(resolver.price);
    const micro = this.computeMicroSignals();

    return { resolver, external, window, micro };
  }

  getWindowData(): WindowData {
    const resolverPrice = this.latestResolver?.price ?? 0;
    return this.computeWindowData(resolverPrice);
  }

  async getHistory(query: HistoryQuery): Promise<{ ticks: PriceTick[]; count: number }> {
    const fromMs = new Date(query.from).getTime();
    const toMs = new Date(query.to).getTime();

    // Try database first
    try {
      const conditions = [gte(priceTicks.eventTime, fromMs), lte(priceTicks.eventTime, toMs)];
      if (query.source !== 'all') {
        conditions.push(
          eq(priceTicks.source, query.source as 'binance' | 'coinbase' | 'polymarket'),
        );
      }
      const rows = await this.db
        .select()
        .from(priceTicks)
        .where(and(...conditions))
        .orderBy(asc(priceTicks.eventTime));

      if (rows.length > 0) {
        const ticks: PriceTick[] = rows.map((r) => ({
          price: r.price,
          timestamp: new Date(r.eventTime).toISOString(),
          source: r.source === 'polymarket' ? ('resolver' as const) : ('external' as const),
          bid: r.bid,
          ask: r.ask,
        }));
        const intervalSec = this.parseInterval(query.interval);
        const sampled = this.downsample(ticks, intervalSec);
        return { ticks: sampled, count: sampled.length };
      }
    } catch {
      /* fall through to in-memory */
    }

    // Fall back to in-memory buffer
    const filtered = this.tickBuffer.filter((tick) => {
      const tickMs = new Date(tick.timestamp).getTime();
      const sourceMatch = query.source === 'all' || tick.source === query.source;
      return tickMs >= fromMs && tickMs <= toMs && sourceMatch;
    });

    const intervalSec = this.parseInterval(query.interval);
    const sampled = this.downsample(filtered, intervalSec);
    return { ticks: sampled, count: sampled.length };
  }

  resetWindow(): WindowResetResult {
    // Take the current resolver price (or external as fallback) as the window start
    const price = this.latestResolver?.price ?? this.latestExternal?.price ?? 0;
    this.windowStartPrice = price;
    this.windowStartTime = Date.now();

    return {
      startPrice: price,
      resetAt: new Date().toISOString(),
    };
  }

  /** Track which 5-minute window we're in to auto-reset at boundaries. */
  private currentWindowSlot = 0;

  private maybeResetWindowBoundary(currentPrice: number): void {
    const nowSec = Math.floor(Date.now() / 1000);
    const slot = Math.floor(nowSec / WINDOW_DURATION_SEC);

    if (this.currentWindowSlot === 0) {
      this.currentWindowSlot = slot;
      return;
    }

    if (slot !== this.currentWindowSlot) {
      // New 5-minute window — reset start price
      this.currentWindowSlot = slot;
      this.windowStartPrice = currentPrice;
      this.windowStartTime = Date.now();
    }
  }

  // ---------------------------------------------------------------------------
  // Binance WebSocket connection
  // ---------------------------------------------------------------------------

  private connectBinanceWs(): void {
    const streamUrl = `${this.wsBaseUrl}/${this.symbol}@bookTicker`;
    this.shouldReconnect = true;

    this.logger.log(`Connecting to Binance WS: ${streamUrl}`);

    try {
      this.ws = new WebSocket(streamUrl);
    } catch (err) {
      this.logger.error(`Failed to create WebSocket: ${(err as Error).message}`);
      this.scheduleReconnect();
      return;
    }

    this.ws.on('open', () => {
      this.reconnectAttempts = 0;
      this.logger.log('Binance WebSocket connected');
    });

    this.ws.on('message', (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString()) as BinanceBookTickerMessage;
        this.handleBookTicker(msg);
      } catch (err) {
        this.logger.error(`Failed to parse Binance message: ${(err as Error).message}`);
      }
    });

    this.ws.on('close', (code, reason) => {
      this.logger.warn(`Binance WS closed: code=${code} reason=${reason?.toString()}`);
      this.ws = null;
      this.scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      this.logger.error(`Binance WS error: ${(err as Error).message}`);
      // 'close' event will fire after 'error', which triggers reconnect
    });
  }

  private disconnectBinanceWs(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close(1000, 'Service shutting down');
      this.ws = null;
    }
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect) return;
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.logger.error(
        `Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached — giving up`,
      );
      return;
    }

    this.reconnectAttempts++;
    // Exponential backoff: 1s, 2s, 4s, 8s, … capped at 30s
    const delay = Math.min(
      BASE_RECONNECT_MS * Math.pow(2, this.reconnectAttempts - 1),
      30_000,
    );

    this.logger.log(
      `Scheduling Binance reconnect #${this.reconnectAttempts} in ${delay}ms`,
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectBinanceWs();
    }, delay);
  }

  // ---------------------------------------------------------------------------
  // Tick handling
  // ---------------------------------------------------------------------------

  /** Exposed for testing — processes a Binance bookTicker message. */
  handleBookTicker(msg: BinanceBookTickerMessage): void {
    const bid = parseFloat(msg.b);
    const ask = parseFloat(msg.a);
    const midPrice = (bid + ask) / 2;
    const now = new Date().toISOString();

    this.lastTickTime = Date.now();

    // Auto-set startPrice on first real tick (avoids delta = currentPrice when startPrice is 0)
    if (this.windowStartPrice === null || this.windowStartPrice === 0) {
      this.windowStartPrice = round(midPrice);
      this.windowStartTime = Date.now();
    }

    // Auto-reset at 5-minute window boundaries
    this.maybeResetWindowBoundary(round(midPrice));

    // Update external price from Binance
    this.latestExternal = {
      price: round(midPrice),
      bid: round(bid),
      ask: round(ask),
      timestamp: now,
    };

    // Use Binance mid-price as resolver proxy (will be replaced with real Polymarket resolver later)
    this.latestResolver = {
      price: round(midPrice),
      timestamp: now,
    };

    // Push ticks into rolling buffer
    const externalTick: PriceTick = {
      price: this.latestExternal.price,
      bid: this.latestExternal.bid,
      ask: this.latestExternal.ask,
      timestamp: now,
      source: 'external',
    };
    const resolverTick: PriceTick = {
      price: this.latestResolver.price,
      timestamp: now,
      source: 'resolver',
    };

    this.pushTick(externalTick);
    this.pushTick(resolverTick);

    // Emit event
    this.emitEvent('price.tick.received', {
      resolver: this.latestResolver,
      external: this.latestExternal,
    });
  }

  private lastPersistTime = 0;
  private static readonly PERSIST_INTERVAL_MS = 5_000; // persist at most every 5s

  private pushTick(tick: PriceTick): void {
    this.tickBuffer.push(tick);
    // Keep buffer bounded
    if (this.tickBuffer.length > BUFFER_MAX_SIZE * 2) {
      this.tickBuffer = this.tickBuffer.slice(-BUFFER_MAX_SIZE);
    }

    // Throttled DB persistence
    const now = Date.now();
    if (now - this.lastPersistTime >= PriceFeedService.PERSIST_INTERVAL_MS && tick.source === 'external') {
      this.lastPersistTime = now;
      this.persistTick(tick).catch(() => {/* best-effort */});
    }
  }

  private async persistTick(tick: PriceTick): Promise<void> {
    await this.db.insert(priceTicks).values({
      windowId: 'live',
      source: 'binance',
      price: tick.price,
      bid: tick.bid ?? tick.price,
      ask: tick.ask ?? tick.price,
      eventTime: new Date(tick.timestamp).getTime(),
      ingestedAt: Date.now(),
    });
  }

  // ---------------------------------------------------------------------------
  // 1s polling timer — recomputes micro signals & checks WS health
  // ---------------------------------------------------------------------------

  private startTickPolling(): void {
    this.pollTimer = setInterval(() => {
      // Check WS staleness — warn if no tick in 3s
      if (this.lastTickTime > 0) {
        const staleness = Date.now() - this.lastTickTime;
        if (staleness > WS_STALE_THRESHOLD_MS) {
          this.logger.warn(
            `No Binance WS tick received in ${Math.round(staleness / 1000)}s`,
          );
        }
      }

      // Micro signals are recomputed lazily via getCurrentPrice(),
      // but we can emit periodic updates here for subscribers if needed.
    }, TICK_POLL_MS);
  }

  private stopTickPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Computation helpers
  // ---------------------------------------------------------------------------

  private computeWindowData(currentPrice: number): WindowData {
    const startPrice = this.windowStartPrice ?? currentPrice;
    const deltaAbs = round(currentPrice - startPrice);
    const deltaPct = startPrice === 0 ? 0 : round(deltaAbs / startPrice, 6);
    const elapsed = this.windowStartTime ? (Date.now() - this.windowStartTime) / 1000 : 0;
    const timeToCloseSec = Math.max(0, Math.round(WINDOW_DURATION_SEC - elapsed));

    return { startPrice, deltaAbs, deltaPct, timeToCloseSec };
  }

  /**
   * Computes micro-structure signals from the rolling tick buffer.
   */
  private computeMicroSignals(): MicroSignals {
    const resolverTicks = this.tickBuffer.filter((t) => t.source === 'resolver');

    const return1s = this.computeReturn(resolverTicks, 1);
    const return5s = this.computeReturn(resolverTicks, 5);
    const return15s = this.computeReturn(resolverTicks, 15);
    const volatility = this.computeVolatility(resolverTicks, 30);
    const momentumScore = this.computeMomentum(return1s, return5s, return15s, volatility);

    return {
      return1s: round(return1s, 6),
      return5s: round(return5s, 6),
      return15s: round(return15s, 6),
      momentumScore: round(momentumScore, 4),
      volatility: round(volatility, 6),
    };
  }

  /**
   * Computes log return over the last N seconds from the tick buffer.
   */
  private computeReturn(ticks: PriceTick[], seconds: number): number {
    if (ticks.length < 2) return 0;

    const now = Date.now();
    const cutoff = now - seconds * 1000;
    const recentTicks = ticks.filter((t) => new Date(t.timestamp).getTime() >= cutoff);

    if (recentTicks.length < 2) return 0;

    const oldest = recentTicks[0];
    const newest = recentTicks[recentTicks.length - 1];
    if (!(oldest && newest)) return 0;

    if (oldest.price <= 0) return 0;
    return (newest.price - oldest.price) / oldest.price;
  }

  /**
   * Computes realized volatility (std dev of 1s returns) over N seconds.
   */
  private computeVolatility(ticks: PriceTick[], seconds: number): number {
    const now = Date.now();
    const cutoff = now - seconds * 1000;
    const recentTicks = ticks.filter((t) => new Date(t.timestamp).getTime() >= cutoff);

    if (recentTicks.length < 3) return 0;

    // Compute 1-second returns
    const returns: number[] = [];
    for (let i = 1; i < recentTicks.length; i++) {
      const prev = recentTicks[i - 1];
      const curr = recentTicks[i];
      if (!(prev && curr)) continue;
      if (prev.price > 0) {
        returns.push((curr.price - prev.price) / prev.price);
      }
    }

    if (returns.length < 2) return 0;

    const mean = returns.reduce((sum, r) => sum + r, 0) / returns.length;
    const variance = returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (returns.length - 1);
    return Math.sqrt(variance);
  }

  /**
   * Computes a composite momentum score from multi-horizon returns and volatility.
   * Score is 0..1 where 0.5 is neutral, >0.5 is upward momentum, <0.5 is downward.
   */
  private computeMomentum(
    return1s: number,
    return5s: number,
    return15s: number,
    volatility: number,
  ): number {
    if (volatility === 0) return 0.5;

    // Weight shorter horizons more heavily
    const weightedReturn = return1s * 0.5 + return5s * 0.3 + return15s * 0.2;

    // Normalize by volatility to get a z-like score
    const zScore = weightedReturn / (volatility || 0.001);

    // Map to 0..1 via sigmoid
    const sigmoid = 1 / (1 + Math.exp(-zScore * 2));
    return Math.max(0, Math.min(1, sigmoid));
  }

  /**
   * Down-samples a tick array to the specified interval in seconds.
   */
  private downsample(ticks: PriceTick[], intervalSec: number): PriceTick[] {
    if (ticks.length === 0 || intervalSec <= 1) return ticks;

    const result: PriceTick[] = [];
    let nextBucketTime = ticks.length > 0 ? new Date(ticks[0]?.timestamp ?? 0).getTime() : 0;

    for (const tick of ticks) {
      const tickMs = new Date(tick.timestamp).getTime();
      if (tickMs >= nextBucketTime) {
        result.push(tick);
        nextBucketTime = tickMs + intervalSec * 1000;
      }
    }

    return result;
  }

  private parseInterval(interval: string): number {
    const match = interval.match(/^(\d+)(s|m|h)?$/);
    if (!match) return 1;
    const value = parseInt(match[1] ?? '1', 10);
    const unit = match[2] ?? 's';
    switch (unit) {
      case 'm':
        return value * 60;
      case 'h':
        return value * 3600;
      default:
        return value;
    }
  }

  private emitEvent<E extends BrainEventName>(event: E, payload: BrainEventMap[E]): void {
    this.eventBus.emit(event, payload);
  }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function round(value: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
