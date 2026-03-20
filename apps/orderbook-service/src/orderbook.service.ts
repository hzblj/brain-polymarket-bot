import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';

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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SNAPSHOT_INTERVAL_MS = 1_000;
const SNAPSHOT_BUFFER_SIZE = 300;

@Injectable()
export class OrderbookService implements OnModuleInit, OnModuleDestroy {
  private currentSnapshot: BookSnapshot | null = null;
  private snapshotHistory: BookSnapshot[] = [];
  private previousMetrics: BookMetrics | null = null;
  private wsTimer: ReturnType<typeof setInterval> | null = null;

  // TODO: inject real dependencies
  // constructor(
  //   private readonly polymarketClient: PolymarketClient,
  //   private readonly database: DatabaseService,
  //   private readonly events: EventsService,
  //   private readonly logger: LoggerService,
  // ) {}

  async onModuleInit(): Promise<void> {
    this.startWebSocketSubscription();
  }

  onModuleDestroy(): void {
    this.stopWebSocketSubscription();
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  async getCurrentSnapshot(): Promise<BookSnapshot | null> {
    return this.currentSnapshot;
  }

  async getDepth(query: DepthQuery): Promise<DepthResult> {
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

  async getMetrics(): Promise<BookMetrics | null> {
    const snapshot = this.currentSnapshot;
    if (!snapshot) return null;
    return this.computeMetrics(snapshot);
  }

  async getHistory(query: HistoryQuery): Promise<{ snapshots: BookSnapshot[]; count: number }> {
    const fromMs = new Date(query.from).getTime();
    const toMs = new Date(query.to).getTime();

    // TODO: query from database for full history
    // const dbSnapshots = await this.database.bookSnapshots.findMany({ from: fromMs, to: toMs });

    const filtered = this.snapshotHistory.filter((s) => {
      const sMs = new Date(s.timestamp).getTime();
      return sMs >= fromMs && sMs <= toMs;
    });

    return { snapshots: filtered, count: filtered.length };
  }

  // ---------------------------------------------------------------------------
  // WebSocket subscription (simulated)
  // ---------------------------------------------------------------------------

  private startWebSocketSubscription(): void {
    // TODO: Replace with real Polymarket WebSocket subscription
    // this.polymarketClient.subscribeOrderbook(tokenIds, (update) => this.handleBookUpdate(update));

    // Simulate book updates at 1 Hz
    this.wsTimer = setInterval(() => {
      try {
        this.handleBookUpdate();
      } catch (error) {
        console.error('[orderbook] WebSocket update error:', error);
      }
    }, SNAPSHOT_INTERVAL_MS);
  }

  private stopWebSocketSubscription(): void {
    if (this.wsTimer) {
      clearInterval(this.wsTimer);
      this.wsTimer = null;
    }
  }

  /**
   * Processes an incoming order book update, normalizes it,
   * computes metrics, detects changes, and emits events.
   */
  private handleBookUpdate(): void {
    const now = new Date().toISOString();

    // Generate simulated book data
    const snapshot: BookSnapshot = {
      up: this.generateSideBook(0.57),
      down: this.generateSideBook(0.42),
      timestamp: now,
    };

    const newMetrics = this.computeMetrics(snapshot);

    // Detect significant changes and emit events
    if (this.previousMetrics) {
      const spreadChanged = Math.abs(newMetrics.spreadBps - this.previousMetrics.spreadBps) > 10;
      const imbalanceChanged = Math.abs(newMetrics.imbalance - this.previousMetrics.imbalance) > 0.05;
      const depthChanged =
        Math.abs(newMetrics.up.bidDepth - this.previousMetrics.up.bidDepth) > 50 ||
        Math.abs(newMetrics.up.askDepth - this.previousMetrics.up.askDepth) > 50;

      if (spreadChanged) this.emitEvent('book.spread.changed', { spreadBps: newMetrics.spreadBps });
      if (imbalanceChanged) this.emitEvent('book.imbalance.changed', { imbalance: newMetrics.imbalance });
      if (depthChanged) this.emitEvent('book.depth.changed', { upBidDepth: newMetrics.up.bidDepth, upAskDepth: newMetrics.up.askDepth });
    }

    this.currentSnapshot = snapshot;
    this.previousMetrics = newMetrics;

    // Store in history buffer
    this.snapshotHistory.push(snapshot);
    if (this.snapshotHistory.length > SNAPSHOT_BUFFER_SIZE) {
      this.snapshotHistory = this.snapshotHistory.slice(-SNAPSHOT_BUFFER_SIZE);
    }

    // Persist to database
    // await this.database.bookSnapshots.insert(snapshot);

    this.emitEvent('book.snapshot.updated', { timestamp: now });
  }

  // ---------------------------------------------------------------------------
  // Computation helpers
  // ---------------------------------------------------------------------------

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

  /**
   * Computes aggregate metrics from a book snapshot.
   */
  private computeMetrics(snapshot: BookSnapshot): BookMetrics {
    const upMetrics = this.computeSideMetrics(snapshot.up);
    const downMetrics = this.computeSideMetrics(snapshot.down);

    // Spread in basis points: difference between best ask of UP and best bid of UP
    const spreadBps = round((upMetrics.spread / ((upMetrics.bestBid + upMetrics.bestAsk) / 2)) * 10_000);

    // Imbalance: (bidDepth - askDepth) / (bidDepth + askDepth) for UP side
    const totalBid = upMetrics.bidDepth + downMetrics.bidDepth;
    const totalAsk = upMetrics.askDepth + downMetrics.askDepth;
    const imbalance = totalBid + totalAsk > 0
      ? round((totalBid - totalAsk) / (totalBid + totalAsk), 4)
      : 0;

    // Microprice: volume-weighted mid price for the UP token
    const microprice = this.computeMicroprice(snapshot.up);

    // Liquidity score: normalized depth relative to a baseline (1000 units)
    const baseline = 1000;
    const totalDepth = upMetrics.bidDepth + upMetrics.askDepth + downMetrics.bidDepth + downMetrics.askDepth;
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
    const bestBid = side.bids.length > 0 ? side.bids[0]!.price : 0;
    const bestAsk = side.asks.length > 0 ? side.asks[0]!.price : 0;
    const spread = round(bestAsk - bestBid, 4);
    const bidDepth = side.bids.reduce((sum, l) => sum + l.size, 0);
    const askDepth = side.asks.reduce((sum, l) => sum + l.size, 0);

    return { bestBid, bestAsk, spread: Math.max(0, spread), bidDepth: round(bidDepth), askDepth: round(askDepth) };
  }

  /**
   * Computes volume-weighted microprice from the best bid and ask.
   * microprice = (bestBid * askSize + bestAsk * bidSize) / (bidSize + askSize)
   */
  private computeMicroprice(side: SideBook): number {
    if (side.bids.length === 0 || side.asks.length === 0) return 0;

    const bestBid = side.bids[0]!;
    const bestAsk = side.asks[0]!;
    const totalSize = bestBid.size + bestAsk.size;

    if (totalSize === 0) return 0;

    return round((bestBid.price * bestAsk.size + bestAsk.price * bestBid.size) / totalSize, 6);
  }

  private emitEvent(event: string, payload: Record<string, unknown>): void {
    // TODO: Wire to @brain/events
    // this.events.emit(event, payload);
    // Only log significant events to avoid noise
    if (event !== 'book.snapshot.updated') {
      console.log(`[orderbook] event: ${event}`, payload);
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
