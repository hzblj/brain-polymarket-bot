import { DATABASE_CLIENT, type DbClient, markets } from '@brain/database';
import { type BrainEventName, type BrainEventMap, EventBus } from '@brain/events';
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { eq } from 'drizzle-orm';

/**
 * Shape of a discovered Polymarket BTC 5-minute market.
 */
interface ActiveMarket {
  marketId: string;
  slug: string;
  question: string;
  conditionId: string;
  upTokenId: string;
  downTokenId: string;
  startTime: string;
  endTime: string;
  status: 'open' | 'closed' | 'resolved';
  discoveredAt: string;
  /** Liquidity & volume from Gamma API */
  liquidityUsd: number;
  volume24hUsd: number;
  volumeTotalUsd: number;
  outcomePrices: { up: number; down: number };
}

interface MarketWindow {
  marketId: string;
  start: string;
  end: string;
  secondsToClose: number;
  isOpen: boolean;
}

interface RefreshResult {
  previousMarketId: string | null;
  currentMarketId: string;
  changed: boolean;
  refreshedAt: string;
}

/**
 * Shape of a market within a Gamma API event response.
 */
interface GammaEventMarket {
  id: string;
  question: string;
  conditionId: string;
  slug: string;
  endDate: string;
  startDate?: string;
  outcomes: string; // JSON string: '["Up", "Down"]'
  outcomePrices: string; // JSON string: '["0.505", "0.495"]'
  clobTokenIds: string; // JSON string with big-number token IDs
  active: boolean;
  closed: boolean;
  enableOrderBook: boolean;
  liquidityNum?: number;
  volumeNum?: number;
  volume24hr?: number;
}

interface GammaEvent {
  id: string;
  slug: string;
  title: string;
  endDate: string;
  active: boolean;
  closed: boolean;
  markets: GammaEventMarket[];
}

const POLL_INTERVAL_MS = 15_000;
const WINDOW_DURATION_SEC = 300; // 5 minutes

@Injectable()
export class MarketDiscoveryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MarketDiscoveryService.name);

  private activeMarket: ActiveMarket | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  private readonly gammaUrl: string;
  private readonly clobUrl: string;
  private readonly apiKey: string | null;
  private readonly apiSecret: string | null;
  private readonly apiPassphrase: string | null;

  constructor(
    @Inject(DATABASE_CLIENT) private readonly db: DbClient,
    private readonly eventBus: EventBus,
  ) {
    this.gammaUrl = process.env.POLYMARKET_GAMMA_URL ?? 'https://gamma-api.polymarket.com';
    this.clobUrl = process.env.POLYMARKET_API_URL ?? 'https://clob.polymarket.com';
    this.apiKey = process.env.POLYMARKET_API_KEY ?? null;
    this.apiSecret = process.env.POLYMARKET_API_SECRET ?? null;
    this.apiPassphrase = process.env.POLYMARKET_API_PASSPHRASE ?? null;
  }

  /** Builds auth headers for Polymarket API calls. */
  private getAuthHeaders(): Record<string, string> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.apiKey) headers['POLY_API_KEY'] = this.apiKey;
    if (this.apiSecret) headers['POLY_API_SECRET'] = this.apiSecret;
    if (this.apiPassphrase) headers['POLY_PASSPHRASE'] = this.apiPassphrase;
    return headers;
  }

  async onModuleInit(): Promise<void> {
    // Perform initial discovery then start polling
    await this.refreshMarket();
    this.startPolling();
  }

  onModuleDestroy(): void {
    this.stopPolling();
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Returns the currently active BTC 5-minute market, or null if none found.
   */
  async getActiveMarket(): Promise<ActiveMarket | null> {
    if (!this.activeMarket || this.isMarketExpired(this.activeMarket)) {
      await this.refreshMarket();
    }
    return this.activeMarket;
  }

  /**
   * Returns timing data for the current 5-minute window.
   */
  async getCurrentWindow(): Promise<MarketWindow | null> {
    const market = await this.getActiveMarket();
    if (!market) return null;

    const now = Date.now();
    const endMs = new Date(market.endTime).getTime();
    const startMs = new Date(market.startTime).getTime();
    const secondsToClose = Math.max(0, Math.floor((endMs - now) / 1000));
    const isOpen = now >= startMs && now < endMs;

    return {
      marketId: market.marketId,
      start: market.startTime,
      end: market.endTime,
      secondsToClose,
      isOpen,
    };
  }

  /**
   * Returns the discovered token IDs for the current active market,
   * or null if no market has been discovered yet.
   */
  getTokenIds(): { upTokenId: string; downTokenId: string } | null {
    if (!this.activeMarket) return null;
    return {
      upTokenId: this.activeMarket.upTokenId,
      downTokenId: this.activeMarket.downTokenId,
    };
  }

  /**
   * Manually refresh market metadata from Polymarket.
   * Discovers the latest active BTC 5-minute market and checks for transitions.
   */
  async refreshMarket(): Promise<RefreshResult> {
    const previousId = this.activeMarket?.marketId ?? null;

    // Fetch the latest active market from Polymarket API
    const discovered = await this.discoverActiveMarket();

    const changed = discovered?.marketId !== previousId;

    if (discovered) {
      this.activeMarket = discovered;

      // Persist to database
      this.persistMarket(discovered).catch(() => {/* best-effort */});

      if (changed && previousId !== null) {
        // Emit market transition event
        this.emitEvent('market.active.changed', {
          previousMarketId: previousId,
          newMarketId: discovered.marketId,
        });
      }

      // Check window state and emit relevant events
      const window = await this.getCurrentWindow();
      if (window?.isOpen && window.secondsToClose > 240) {
        this.emitEvent('market.window.opened', {
          marketId: discovered.marketId,
          start: discovered.startTime,
          end: discovered.endTime,
        });
      } else if (window?.isOpen && window.secondsToClose <= 30) {
        this.emitEvent('market.window.closing', {
          marketId: discovered.marketId,
          secondsToClose: window.secondsToClose,
        });
      }
    }

    return {
      previousMarketId: previousId,
      currentMarketId: discovered?.marketId ?? previousId ?? 'none',
      changed,
      refreshedAt: new Date().toISOString(),
    };
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /**
   * Discovers the current active "Bitcoin Up or Down - 5 Minutes" market.
   *
   * Strategy: BTC 5-minute markets use a predictable slug pattern:
   *   btc-updown-5m-{unix_window_start}
   * We compute the current and next window timestamps and query the Gamma
   * events API directly by slug. This is much more reliable than searching
   * across all markets.
   */
  private async discoverActiveMarket(): Promise<ActiveMarket | null> {
    try {
      const market = await this.fetchBySlugPattern();
      if (market) {
        this.logger.log(
          `Discovered market: slug=${market.slug} question="${market.question}" end=${market.endTime} UP=${market.upTokenId.slice(0, 16)}...`,
        );
        return market;
      }

      this.logger.warn('No BTC 5-minute market found via slug pattern, falling back to stub');
      return this.generateStubMarket();
    } catch (error) {
      this.logger.warn(
        `Market discovery failed (${error instanceof Error ? error.message : String(error)}), falling back to stub`,
      );
      return this.generateStubMarket();
    }
  }

  /**
   * Queries the Gamma API for BTC 5-minute events using the known slug pattern.
   * Tries the current window and the next window.
   */
  private async fetchBySlugPattern(): Promise<ActiveMarket | null> {
    const nowSec = Math.floor(Date.now() / 1000);
    const currentWindowStart = Math.floor(nowSec / WINDOW_DURATION_SEC) * WINDOW_DURATION_SEC;
    const nextWindowStart = currentWindowStart + WINDOW_DURATION_SEC;

    // Try current window first, then next
    for (const windowStart of [currentWindowStart, nextWindowStart]) {
      const slug = `btc-updown-5m-${windowStart}`;
      const market = await this.fetchEventBySlug(slug);
      if (market && !market.closed && new Date(market.endTime).getTime() > Date.now()) {
        return market;
      }
    }

    return null;
  }

  /**
   * Fetches a single event from the Gamma API by slug and converts it.
   */
  private async fetchEventBySlug(slug: string): Promise<ActiveMarket | null> {
    const url = `${this.gammaUrl}/events?slug=${encodeURIComponent(slug)}`;
    this.logger.debug(`Fetching event: ${url}`);

    const response = await fetch(url, {
      headers: this.getAuthHeaders(),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      this.logger.debug(`Gamma API returned ${response.status} for slug ${slug}`);
      return null;
    }

    const events = (await response.json()) as GammaEvent[];
    if (!events.length || !events[0]?.markets?.length) return null;

    const event = events[0]!;
    const m = event.markets[0]!;

    if (!m.active || m.closed || !m.clobTokenIds) return null;

    return this.gammaEventMarketToActiveMarket(m, event.slug);
  }

  /**
   * Converts a Gamma event market into our internal ActiveMarket shape.
   */
  private gammaEventMarketToActiveMarket(m: GammaEventMarket, slug: string): ActiveMarket {
    const outcomes: string[] = JSON.parse(m.outcomes);
    const tokenIds: string[] = JSON.parse(m.clobTokenIds);

    // Map "Up" outcome to upTokenId, "Down" to downTokenId
    const upIdx = outcomes.findIndex((o) => o.toLowerCase() === 'up' || o.toLowerCase() === 'yes');
    const downIdx = outcomes.findIndex((o) => o.toLowerCase() === 'down' || o.toLowerCase() === 'no');

    const upTokenId = tokenIds[upIdx >= 0 ? upIdx : 0]!;
    const downTokenId = tokenIds[downIdx >= 0 ? downIdx : 1]!;

    const endMs = new Date(m.endDate).getTime();
    const startMs = endMs - WINDOW_DURATION_SEC * 1000;

    // Parse outcome prices
    let upPrice = 0.5;
    let downPrice = 0.5;
    try {
      const prices: string[] = JSON.parse(m.outcomePrices);
      upPrice = parseFloat(prices[upIdx >= 0 ? upIdx : 0] ?? '0.5');
      downPrice = parseFloat(prices[downIdx >= 0 ? downIdx : 1] ?? '0.5');
    } catch { /* use defaults */ }

    return {
      marketId: m.id,
      slug,
      question: m.question,
      conditionId: m.conditionId,
      upTokenId,
      downTokenId,
      startTime: new Date(startMs).toISOString(),
      endTime: m.endDate,
      status: 'open',
      discoveredAt: new Date().toISOString(),
      liquidityUsd: m.liquidityNum ?? 0,
      volume24hUsd: m.volume24hr ?? 0,
      volumeTotalUsd: m.volumeNum ?? 0,
      outcomePrices: { up: upPrice, down: downPrice },
    };
  }

  /**
   * Fallback stub: generates a deterministic fake market based on the current
   * 5-minute time window. Ensures the service always returns something even
   * when the Polymarket API is unavailable.
   */
  private generateStubMarket(): ActiveMarket {
    const now = new Date();
    const windowStartMs =
      Math.floor(now.getTime() / (WINDOW_DURATION_SEC * 1000)) * (WINDOW_DURATION_SEC * 1000);
    const windowStart = new Date(windowStartMs);
    const windowEnd = new Date(windowStartMs + WINDOW_DURATION_SEC * 1000);

    return {
      marketId: `btc-5m-${windowStart.toISOString().replace(/[:.]/g, '-')}`,
      slug: 'bitcoin-up-or-down-5-minutes',
      question: 'Will Bitcoin go up or down in the next 5 minutes?',
      conditionId: `0x${this.hashString(`btc-5m-${windowStartMs}`)}`,
      upTokenId: `0x${this.hashString(`up-${windowStartMs}`)}`,
      downTokenId: `0x${this.hashString(`down-${windowStartMs}`)}`,
      startTime: windowStart.toISOString(),
      endTime: windowEnd.toISOString(),
      status: 'open',
      discoveredAt: now.toISOString(),
      liquidityUsd: 0,
      volume24hUsd: 0,
      volumeTotalUsd: 0,
      outcomePrices: { up: 0.5, down: 0.5 },
    };
  }

  private async persistMarket(market: ActiveMarket): Promise<void> {
    const existing = await this.db
      .select()
      .from(markets)
      .where(eq(markets.conditionId, market.conditionId))
      .limit(1);

    if (existing.length === 0) {
      await this.db.insert(markets).values({
        conditionId: market.conditionId,
        slug: market.slug,
        status: 'active',
      });
    }
  }

  private isMarketExpired(market: ActiveMarket): boolean {
    return new Date(market.endTime).getTime() < Date.now();
  }

  private startPolling(): void {
    this.pollTimer = setInterval(async () => {
      try {
        await this.refreshMarket();
      } catch (_error) {
        /* ignored - will retry on next interval */
      }
    }, POLL_INTERVAL_MS);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private emitEvent<E extends BrainEventName>(event: E, payload: BrainEventMap[E]): void {
    this.eventBus.emit(event, payload);
  }

  /** Simple deterministic hex hash for stub IDs. */
  private hashString(input: string): string {
    let hash = 0;
    for (let i = 0; i < input.length; i++) {
      const char = input.charCodeAt(i);
      hash = ((hash << 5) - hash + char) | 0;
    }
    return Math.abs(hash).toString(16).padStart(16, '0');
  }
}
