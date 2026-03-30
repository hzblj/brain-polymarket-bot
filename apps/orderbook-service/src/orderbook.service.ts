import { bookSnapshots, DATABASE_CLIENT, type DbClient } from '@brain/database';
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { and, desc, gte, lte } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface OrderLevel {
  price: number;
  size: number;
  /** Cumulative size from best to this level. */
  cumSize: number;
}

interface SideBook {
  bids: OrderLevel[];
  asks: OrderLevel[];
}

interface BookSnapshot {
  up: SideBook;
  down: SideBook;
  timestamp: string;
}

interface DepthQuery {
  levels: number;
  side: 'up' | 'down';
}

interface DepthResult {
  side: 'up' | 'down';
  bids: OrderLevel[];
  asks: OrderLevel[];
  totalBidSize: number;
  totalAskSize: number;
}

interface BookMetrics {
  up: SideMetrics;
  down: SideMetrics;
  spreadBps: number;
  imbalance: number;
  microprice: number;
  liquidityScore: number;
  timestamp: string;
}

interface SideMetrics {
  bestBid: number;
  bestAsk: number;
  spread: number;
  bidDepth: number;
  askDepth: number;
}

interface HistoryQuery {
  from: string;
  to: string;
}

/** Shape returned by the Polymarket CLOB REST API for a single token book. */
interface PolymarketBookResponse {
  market: string;
  asset_id: string;
  bids: { price: string; size: string }[];
  asks: { price: string; size: string }[];
  hash: string;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 2_000;
const SIMULATED_INTERVAL_MS = 1_000;
const SNAPSHOT_BUFFER_SIZE = 300;

@Injectable()
export class OrderbookService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OrderbookService.name);

  private currentSnapshot: BookSnapshot | null = null;
  private snapshotHistory: BookSnapshot[] = [];
  private previousMetrics: BookMetrics | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  /** Token IDs — from env or auto-discovered from market-discovery service. */
  private upTokenId: string | null = null;
  private downTokenId: string | null = null;
  private apiUrl = 'https://clob.polymarket.com';
  private marketDiscoveryUrl = 'http://localhost:3001';

  /** Polymarket API auth headers. */
  private apiKey: string | null = null;
  private apiSecret: string | null = null;
  private apiPassphrase: string | null = null;

  constructor(@Inject(DATABASE_CLIENT) private readonly db: DbClient) {}

  async onModuleInit(): Promise<void> {
    this.upTokenId = process.env.POLYMARKET_UP_TOKEN_ID ?? null;
    this.downTokenId = process.env.POLYMARKET_DOWN_TOKEN_ID ?? null;
    this.apiUrl = process.env.POLYMARKET_API_URL ?? 'https://clob.polymarket.com';
    this.marketDiscoveryUrl = process.env.MARKET_SERVICE_URL ?? `http://${process.env.MARKET_DISCOVERY_HOST ?? 'localhost'}:3001`;

    // Auth headers
    this.apiKey = process.env.POLYMARKET_API_KEY ?? null;
    this.apiSecret = process.env.POLYMARKET_API_SECRET ?? null;
    this.apiPassphrase = process.env.POLYMARKET_API_PASSPHRASE ?? null;

    // Auto-discover token IDs from market-discovery if not set in env
    if (!this.upTokenId || !this.downTokenId) {
      await this.discoverTokenIds();
    }

    if (this.upTokenId && this.downTokenId) {
      this.logger.log(
        `Starting REST polling for real Polymarket orderbook (UP=${this.upTokenId.slice(0, 12)}... DOWN=${this.downTokenId.slice(0, 12)}...)`,
      );
      this.startRestPolling();
    } else {
      this.logger.warn(
        'No token IDs available – falling back to simulated data',
      );
      this.startSimulatedPolling();
    }

    // Re-discover token IDs periodically (market windows rotate every 5 min)
    this.startTokenDiscoveryPolling();
  }

  onModuleDestroy(): void {
    this.stopPolling();
    if (this.tokenDiscoveryTimer) {
      clearInterval(this.tokenDiscoveryTimer);
      this.tokenDiscoveryTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  getCurrentSnapshot(): BookSnapshot | null {
    return this.currentSnapshot;
  }

  getDepth(query: DepthQuery): DepthResult {
    const snapshot = this.currentSnapshot;
    if (!snapshot) {
      return { side: query.side, bids: [], asks: [], totalBidSize: 0, totalAskSize: 0 };
    }

    const sideBook = query.side === 'up' ? snapshot.up : snapshot.down;
    const bids = sideBook.bids.slice(0, query.levels);
    const asks = sideBook.asks.slice(0, query.levels);

    return {
      side: query.side,
      bids,
      asks,
      totalBidSize: bids.reduce((sum, l) => sum + l.size, 0),
      totalAskSize: asks.reduce((sum, l) => sum + l.size, 0),
    };
  }

  getMetrics(): BookMetrics | null {
    const snapshot = this.currentSnapshot;
    if (!snapshot) return null;
    return this.computeMetrics(snapshot);
  }

  async getHistory(query: HistoryQuery): Promise<{ snapshots: BookSnapshot[]; count: number }> {
    const fromMs = new Date(query.from).getTime();
    const toMs = new Date(query.to).getTime();

    // Try database
    try {
      const rows = await this.db
        .select()
        .from(bookSnapshots)
        .where(and(gte(bookSnapshots.eventTime, fromMs), lte(bookSnapshots.eventTime, toMs)))
        .orderBy(desc(bookSnapshots.eventTime));

      if (rows.length > 0) {
        return {
          snapshots: rows.map((r) => ({
            up: { bids: [], asks: [] },
            down: { bids: [], asks: [] },
            timestamp: new Date(r.eventTime).toISOString(),
          })),
          count: rows.length,
        };
      }
    } catch {
      /* fall through */
    }

    // Fall back to in-memory
    const filtered = this.snapshotHistory.filter((s) => {
      const sMs = new Date(s.timestamp).getTime();
      return sMs >= fromMs && sMs <= toMs;
    });

    return { snapshots: filtered, count: filtered.length };
  }

  // ---------------------------------------------------------------------------
  // REST polling (real Polymarket data)
  // ---------------------------------------------------------------------------

  private startRestPolling(): void {
    // Fire immediately, then on interval
    void this.pollOrderbooks();

    this.pollTimer = setInterval(() => {
      void this.pollOrderbooks();
    }, POLL_INTERVAL_MS);
  }

  private consecutiveFailures = 0;
  private static readonly MAX_FAILURES_BEFORE_FALLBACK = 5;

  private async pollOrderbooks(): Promise<void> {
    try {
      const [upBook, downBook] = await Promise.all([
        this.fetchBook(this.upTokenId!),
        this.fetchBook(this.downTokenId!),
      ]);

      this.consecutiveFailures = 0;

      const now = new Date().toISOString();
      const snapshot: BookSnapshot = {
        up: this.parseSideBook(upBook),
        down: this.parseSideBook(downBook),
        timestamp: now,
      };

      this.applySnapshot(snapshot);
    } catch (error) {
      this.consecutiveFailures++;
      this.logger.error(`Failed to poll orderbook (${this.consecutiveFailures}/${OrderbookService.MAX_FAILURES_BEFORE_FALLBACK}): ${error instanceof Error ? error.message : String(error)}`);

      if (this.consecutiveFailures >= OrderbookService.MAX_FAILURES_BEFORE_FALLBACK) {
        this.logger.warn('Too many consecutive failures — switching to simulated data');
        this.stopPolling();
        this.startSimulatedPolling();
      }
    }
  }

  private async fetchBook(tokenId: string): Promise<PolymarketBookResponse> {
    const url = `${this.apiUrl}/book?token_id=${encodeURIComponent(tokenId)}`;
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.apiKey) headers['POLY_API_KEY'] = this.apiKey;
    if (this.apiSecret) headers['POLY_API_SECRET'] = this.apiSecret;
    if (this.apiPassphrase) headers['POLY_PASSPHRASE'] = this.apiPassphrase;

    const response = await fetch(url, { headers, signal: AbortSignal.timeout(8_000) });

    if (!response.ok) {
      throw new Error(`Polymarket API returned ${response.status} for token ${tokenId}`);
    }

    return (await response.json()) as PolymarketBookResponse;
  }

  /**
   * Auto-discovers token IDs by calling the market-discovery service.
   */
  private async discoverTokenIds(): Promise<void> {
    try {
      const url = `${this.marketDiscoveryUrl}/api/v1/market/tokens`;
      const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      if (!response.ok) return;

      const body = (await response.json()) as { ok: boolean; data: { upTokenId: string; downTokenId: string } | null };
      if (body.ok && body.data) {
        const changed = body.data.upTokenId !== this.upTokenId || body.data.downTokenId !== this.downTokenId;
        this.upTokenId = body.data.upTokenId;
        this.downTokenId = body.data.downTokenId;
        if (changed) {
          this.logger.log(`Token IDs updated from market-discovery: UP=${this.upTokenId.slice(0, 12)}... DOWN=${this.downTokenId.slice(0, 12)}...`);
        }
      }
    } catch (err) {
      this.logger.debug(`Could not fetch token IDs from market-discovery: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private tokenDiscoveryTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Periodically re-discovers token IDs from market-discovery (every 60s).
   * Markets rotate every 5 min, so this ensures we always have fresh IDs.
   */
  private startTokenDiscoveryPolling(): void {
    this.tokenDiscoveryTimer = setInterval(async () => {
      const prevUp = this.upTokenId;
      await this.discoverTokenIds();
      // If tokens changed and we have valid new ones, restart book polling
      if (this.upTokenId && this.downTokenId && (this.upTokenId !== prevUp)) {
        this.stopPolling();
        this.startRestPolling();
      }
    }, 60_000);
  }

  /**
   * Converts a raw Polymarket book response into the internal SideBook format.
   * Bids are sorted best (highest) first, asks are sorted best (lowest) first.
   * cumSize is a running total from best to worst.
   */
  private parseSideBook(raw: PolymarketBookResponse): SideBook {
    // Parse and sort bids descending by price (best bid = highest)
    const parsedBids = raw.bids
      .map((b) => ({ price: parseFloat(b.price), size: parseFloat(b.size) }))
      .sort((a, b) => b.price - a.price);

    // Parse and sort asks ascending by price (best ask = lowest)
    const parsedAsks = raw.asks
      .map((a) => ({ price: parseFloat(a.price), size: parseFloat(a.size) }))
      .sort((a, b) => a.price - b.price);

    // Build OrderLevel arrays with cumulative sizes
    let cumBid = 0;
    const bids: OrderLevel[] = parsedBids.map((b) => {
      cumBid += b.size;
      return { price: round(b.price, 4), size: round(b.size), cumSize: round(cumBid) };
    });

    let cumAsk = 0;
    const asks: OrderLevel[] = parsedAsks.map((a) => {
      cumAsk += a.size;
      return { price: round(a.price, 4), size: round(a.size), cumSize: round(cumAsk) };
    });

    return { bids, asks };
  }

  // ---------------------------------------------------------------------------
  // Simulated polling (fallback when no token IDs configured)
  // ---------------------------------------------------------------------------

  private startSimulatedPolling(): void {
    this.pollTimer = setInterval(() => {
      try {
        this.handleSimulatedUpdate();
      } catch (_error) {
        /* ignored - will retry on next interval */
      }
    }, SIMULATED_INTERVAL_MS);
  }

  private handleSimulatedUpdate(): void {
    const now = new Date().toISOString();
    const snapshot: BookSnapshot = {
      up: this.generateSideBook(0.57),
      down: this.generateSideBook(0.42),
      timestamp: now,
    };
    this.applySnapshot(snapshot);
  }

  /**
   * Generates a simulated side of the order book around a mid price.
   */
  private generateSideBook(midPrice: number): SideBook {
    const levels = 10;
    const bids: OrderLevel[] = [];
    const asks: OrderLevel[] = [];

    let cumBid = 0;
    let cumAsk = 0;

    for (let i = 0; i < levels; i++) {
      const bidPrice = round(midPrice - 0.01 * (i + 1) - Math.random() * 0.005);
      const askPrice = round(midPrice + 0.01 * (i + 1) + Math.random() * 0.005);
      const bidSize = round(50 + Math.random() * 200);
      const askSize = round(50 + Math.random() * 200);

      cumBid += bidSize;
      cumAsk += askSize;

      bids.push({ price: Math.max(0.01, bidPrice), size: bidSize, cumSize: round(cumBid) });
      asks.push({ price: Math.min(0.99, askPrice), size: askSize, cumSize: round(cumAsk) });
    }

    return { bids, asks };
  }

  // ---------------------------------------------------------------------------
  // Common snapshot handling
  // ---------------------------------------------------------------------------

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /**
   * Applies a new snapshot: computes metrics, detects changes, emits events,
   * stores in history buffer.
   */
  private applySnapshot(snapshot: BookSnapshot): void {
    const newMetrics = this.computeMetrics(snapshot);

    // Detect significant changes and emit events
    if (this.previousMetrics) {
      const spreadChanged = Math.abs(newMetrics.spreadBps - this.previousMetrics.spreadBps) > 10;
      const imbalanceChanged =
        Math.abs(newMetrics.imbalance - this.previousMetrics.imbalance) > 0.05;
      const depthChanged =
        Math.abs(newMetrics.up.bidDepth - this.previousMetrics.up.bidDepth) > 50 ||
        Math.abs(newMetrics.up.askDepth - this.previousMetrics.up.askDepth) > 50;

      if (spreadChanged) this.emitEvent('book.spread.changed', { spreadBps: newMetrics.spreadBps });
      if (imbalanceChanged)
        this.emitEvent('book.imbalance.changed', { imbalance: newMetrics.imbalance });
      if (depthChanged)
        this.emitEvent('book.depth.changed', {
          upBidDepth: newMetrics.up.bidDepth,
          upAskDepth: newMetrics.up.askDepth,
        });
    }

    this.currentSnapshot = snapshot;
    this.previousMetrics = newMetrics;

    // Store in history buffer
    this.snapshotHistory.push(snapshot);
    if (this.snapshotHistory.length > SNAPSHOT_BUFFER_SIZE) {
      this.snapshotHistory = this.snapshotHistory.slice(-SNAPSHOT_BUFFER_SIZE);
    }

    // Persist to database (throttled — every 5s)
    this.persistSnapshot(newMetrics).catch(() => {/* best-effort */});

    this.emitEvent('book.snapshot.updated', { timestamp: snapshot.timestamp });
  }

  // ---------------------------------------------------------------------------
  // Computation helpers
  // ---------------------------------------------------------------------------

  /**
   * Computes aggregate metrics from a book snapshot.
   */
  private computeMetrics(snapshot: BookSnapshot): BookMetrics {
    const upMetrics = this.computeSideMetrics(snapshot.up);
    const downMetrics = this.computeSideMetrics(snapshot.down);

    // Spread in basis points: difference between best ask of UP and best bid of UP
    const spreadBps = round(
      (upMetrics.spread / ((upMetrics.bestBid + upMetrics.bestAsk) / 2)) * 10_000,
    );

    // Imbalance: (bidDepth - askDepth) / (bidDepth + askDepth) for UP side
    const totalBid = upMetrics.bidDepth + downMetrics.bidDepth;
    const totalAsk = upMetrics.askDepth + downMetrics.askDepth;
    const imbalance =
      totalBid + totalAsk > 0 ? round((totalBid - totalAsk) / (totalBid + totalAsk), 4) : 0;

    // Microprice: volume-weighted mid price for the UP token
    const microprice = this.computeMicroprice(snapshot.up);

    // Liquidity score: normalized depth relative to a baseline (1000 units)
    const baseline = 1000;
    const totalDepth =
      upMetrics.bidDepth + upMetrics.askDepth + downMetrics.bidDepth + downMetrics.askDepth;
    const liquidityScore = round(Math.min(1, totalDepth / (baseline * 4)), 4);

    return {
      up: upMetrics,
      down: downMetrics,
      spreadBps,
      imbalance,
      microprice,
      liquidityScore,
      timestamp: snapshot.timestamp,
    };
  }

  private computeSideMetrics(side: SideBook): SideMetrics {
    const bestBid = (side.bids.length > 0 ? side.bids[0]?.price : 0) ?? 0;
    const bestAsk = (side.asks.length > 0 ? side.asks[0]?.price : 0) ?? 0;
    const spread = round(bestAsk - bestBid, 4);
    const bidDepth = side.bids.reduce((sum, l) => sum + l.size, 0);
    const askDepth = side.asks.reduce((sum, l) => sum + l.size, 0);

    return {
      bestBid,
      bestAsk,
      spread: Math.max(0, spread),
      bidDepth: round(bidDepth),
      askDepth: round(askDepth),
    };
  }

  /**
   * Computes volume-weighted microprice from the best bid and ask.
   * microprice = (bestBid * askSize + bestAsk * bidSize) / (bidSize + askSize)
   */
  private computeMicroprice(side: SideBook): number {
    if (side.bids.length === 0 || side.asks.length === 0) return 0;

    const bestBid = side.bids[0];
    const bestAsk = side.asks[0];
    if (!(bestBid && bestAsk)) return 0;
    const totalSize = bestBid.size + bestAsk.size;

    if (totalSize === 0) return 0;

    return round((bestBid.price * bestAsk.size + bestAsk.price * bestBid.size) / totalSize, 6);
  }

  private lastPersistTime = 0;
  private static readonly PERSIST_INTERVAL_MS = 5_000;

  private async persistSnapshot(metrics: BookMetrics): Promise<void> {
    const now = Date.now();
    if (now - this.lastPersistTime < OrderbookService.PERSIST_INTERVAL_MS) return;
    this.lastPersistTime = now;

    await this.db.insert(bookSnapshots).values({
      windowId: 'live',
      upBid: metrics.up.bestBid,
      upAsk: metrics.up.bestAsk,
      downBid: metrics.down.bestBid,
      downAsk: metrics.down.bestAsk,
      spreadBps: metrics.spreadBps,
      depthScore: metrics.liquidityScore,
      imbalance: metrics.imbalance,
      eventTime: new Date(metrics.timestamp).getTime(),
      ingestedAt: now,
    });
  }

  private emitEvent(event: string, _payload: Record<string, unknown>): void {
    // TODO: Wire to @brain/events
    // this.events.emit(event, payload);
    // Only log significant events to avoid noise
    if (event !== 'book.snapshot.updated') {
      // TODO: log significant events
    }
  }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function round(value: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
