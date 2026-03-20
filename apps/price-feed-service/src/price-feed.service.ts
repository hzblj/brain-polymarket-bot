import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

@Injectable()
export class PriceFeedService implements OnModuleInit, OnModuleDestroy {
  /** Rolling buffer of recent ticks (newest last). */
  private tickBuffer: PriceTick[] = [];

  /** Latest prices by source. */
  private latestResolver: ResolverPrice | null = null;
  private latestExternal: ExternalPrice | null = null;

  /** Start price for the current 5-minute window. */
  private windowStartPrice: number | null = null;
  private windowStartTime: number | null = null;

  private pollTimer: ReturnType<typeof setInterval> | null = null;

  // TODO: inject real dependencies
  // constructor(
  //   private readonly exchangeClients: ExchangeClientsService,
  //   private readonly polymarketClient: PolymarketClient,
  //   private readonly database: DatabaseService,
  //   private readonly events: EventsService,
  //   private readonly logger: LoggerService,
  // ) {}

  async onModuleInit(): Promise<void> {
    await this.resetWindow();
    this.startTickCollection();
  }

  onModuleDestroy(): void {
    this.stopTickCollection();
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  async getCurrentPrice(): Promise<CurrentPricePayload> {
    const resolver = this.latestResolver ?? { price: 0, timestamp: new Date().toISOString() };
    const external = this.latestExternal ?? { price: 0, bid: 0, ask: 0, timestamp: new Date().toISOString() };
    const window = this.computeWindowData(resolver.price);
    const micro = this.computeMicroSignals();

    return { resolver, external, window, micro };
  }

  async getWindowData(): Promise<WindowData> {
    const resolverPrice = this.latestResolver?.price ?? 0;
    return this.computeWindowData(resolverPrice);
  }

  async getHistory(query: HistoryQuery): Promise<{ ticks: PriceTick[]; count: number }> {
    const fromMs = new Date(query.from).getTime();
    const toMs = new Date(query.to).getTime();

    // TODO: query from database for full history
    // const dbTicks = await this.database.priceTicks.findMany({ from: fromMs, to: toMs, source: query.source });

    // For now, filter from in-memory buffer
    const filtered = this.tickBuffer.filter((tick) => {
      const tickMs = new Date(tick.timestamp).getTime();
      const sourceMatch = query.source === 'all' || tick.source === query.source;
      return tickMs >= fromMs && tickMs <= toMs && sourceMatch;
    });

    // Down-sample to requested interval
    const intervalSec = this.parseInterval(query.interval);
    const sampled = this.downsample(filtered, intervalSec);

    return { ticks: sampled, count: sampled.length };
  }

  async resetWindow(): Promise<WindowResetResult> {
    // Take the current resolver price (or external as fallback) as the window start
    const price = this.latestResolver?.price ?? this.latestExternal?.price ?? 0;
    this.windowStartPrice = price;
    this.windowStartTime = Date.now();

    // Persist to database
    // await this.database.windowStarts.insert({ price, timestamp: new Date().toISOString() });

    return {
      startPrice: price,
      resetAt: new Date().toISOString(),
    };
  }

  // ---------------------------------------------------------------------------
  // Tick collection
  // ---------------------------------------------------------------------------

  private startTickCollection(): void {
    this.pollTimer = setInterval(async () => {
      try {
        await this.collectTick();
      } catch (error) {
        console.error('[price-feed] Tick collection error:', error);
      }
    }, TICK_POLL_MS);
  }

  private stopTickCollection(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /**
   * Fetches prices from resolver proxy and external exchanges,
   * pushes them into the rolling buffer, and emits tick events.
   */
  private async collectTick(): Promise<void> {
    const now = new Date().toISOString();

    // TODO: Replace with real API calls
    // const resolverData = await this.polymarketClient.getResolverPrice('BTC');
    // const externalData = await this.exchangeClients.getSpotPrice('BTC');

    // Stub: simulate resolver and external prices
    const basePrice = 84250 + Math.random() * 20 - 10;
    const spread = 0.2 + Math.random() * 0.3;

    this.latestResolver = { price: round(basePrice + Math.random() * 2), timestamp: now };
    this.latestExternal = {
      price: round(basePrice),
      bid: round(basePrice - spread),
      ask: round(basePrice + spread),
      timestamp: now,
    };

    // Push both ticks into buffer
    const resolverTick: PriceTick = { price: this.latestResolver.price, timestamp: now, source: 'resolver' };
    const externalTick: PriceTick = {
      price: this.latestExternal.price,
      bid: this.latestExternal.bid,
      ask: this.latestExternal.ask,
      timestamp: now,
      source: 'external',
    };

    this.pushTick(resolverTick);
    this.pushTick(externalTick);

    // Persist to database
    // await this.database.priceTicks.insertMany([resolverTick, externalTick]);

    // Emit event
    this.emitEvent('price.tick.received', { resolver: this.latestResolver, external: this.latestExternal });
  }

  private pushTick(tick: PriceTick): void {
    this.tickBuffer.push(tick);
    // Keep buffer bounded
    if (this.tickBuffer.length > BUFFER_MAX_SIZE * 2) {
      this.tickBuffer = this.tickBuffer.slice(-BUFFER_MAX_SIZE);
    }
  }

  // ---------------------------------------------------------------------------
  // Computation helpers
  // ---------------------------------------------------------------------------

  private computeWindowData(currentPrice: number): WindowData {
    const startPrice = this.windowStartPrice ?? currentPrice;
    const deltaAbs = round(currentPrice - startPrice);
    const deltaPct = startPrice !== 0 ? round(deltaAbs / startPrice, 6) : 0;
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

    const oldest = recentTicks[0]!;
    const newest = recentTicks[recentTicks.length - 1]!;

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
      const prev = recentTicks[i - 1]!;
      const curr = recentTicks[i]!;
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
  private computeMomentum(return1s: number, return5s: number, return15s: number, volatility: number): number {
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
    let nextBucketTime = ticks.length > 0 ? new Date(ticks[0]!.timestamp).getTime() : 0;

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
    const value = parseInt(match[1]!, 10);
    const unit = match[2] ?? 's';
    switch (unit) {
      case 'm': return value * 60;
      case 'h': return value * 3600;
      default: return value;
    }
  }

  private emitEvent(event: string, payload: Record<string, unknown>): void {
    // TODO: Wire to @brain/events
    // this.events.emit(event, payload);
    console.log(`[price-feed] event: ${event}`);
  }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function round(value: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
