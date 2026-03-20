import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';

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

const POLL_INTERVAL_MS = 15_000;
const WINDOW_DURATION_SEC = 300; // 5 minutes

@Injectable()
export class MarketDiscoveryService implements OnModuleInit, OnModuleDestroy {
  private activeMarket: ActiveMarket | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  // TODO: inject real dependencies once wired
  // constructor(
  //   private readonly polymarketClient: PolymarketClient,
  //   private readonly database: DatabaseService,
  //   private readonly events: EventsService,
  //   private readonly logger: LoggerService,
  // ) {}

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
      // await this.database.markets.upsert(discovered);

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
   * Discovers the current active "Bitcoin Up or Down - 5 Minutes" market
   * from the Polymarket API.
   */
  private async discoverActiveMarket(): Promise<ActiveMarket | null> {
    try {
      // TODO: Replace with real polymarket-client call:
      // const markets = await this.polymarketClient.getActiveMarkets({
      //   query: 'Bitcoin Up or Down 5 Minutes',
      //   status: 'open',
      // });

      // Stub: simulate discovery of an active market
      const now = new Date();
      const windowStartMs = Math.floor(now.getTime() / (WINDOW_DURATION_SEC * 1000)) * (WINDOW_DURATION_SEC * 1000);
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
      };
    } catch (error) {
      // await this.logger.error('Failed to discover active market', { error });
      console.error('[market-discovery] Failed to discover active market:', error);
      return this.activeMarket; // fall back to cached
    }
  }

  private isMarketExpired(market: ActiveMarket): boolean {
    return new Date(market.endTime).getTime() < Date.now();
  }

  private startPolling(): void {
    this.pollTimer = setInterval(async () => {
      try {
        await this.refreshMarket();
      } catch (error) {
        console.error('[market-discovery] Poll cycle error:', error);
      }
    }, POLL_INTERVAL_MS);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private emitEvent(event: string, payload: Record<string, unknown>): void {
    // TODO: Wire to @brain/events
    // this.events.emit(event, payload);
    console.log(`[market-discovery] event: ${event}`, payload);
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
