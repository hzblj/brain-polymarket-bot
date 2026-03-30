import { DATABASE_CLIENT, type DbClient, whaleSnapshots } from '@brain/database';
import { type BrainEventName, type BrainEventMap, EventBus } from '@brain/events';
import { BrainLoggerService } from '@brain/logger';
import type { WhaleFeatures, WhaleTransaction } from '@brain/types';
import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { desc } from 'drizzle-orm';
import WebSocket from 'ws';

// ─── Constants ──────────────────────────────────────────────────────────────

const MEMPOOL_WS_URL = process.env.MEMPOOL_WS_URL ?? 'wss://mempool.space/api/v1/ws';

/** Minimum BTC value to consider a transaction "whale-sized" */
const WHALE_THRESHOLD_BTC = parseFloat(process.env.WHALE_THRESHOLD_BTC ?? '10');

/** How long to keep transactions in the rolling window (5 minutes = match trading window) */
const ROLLING_WINDOW_MS = 5 * 60 * 1000;

/** Snapshot persistence interval */
const PERSIST_INTERVAL_MS = 10_000;

/** History buffer size */
const HISTORY_BUFFER_SIZE = 300;

/** Reconnect backoff */
const BASE_RECONNECT_MS = 1_000;
const MAX_RECONNECT_MS = 30_000;

/** BTC price fetch interval (used for USD conversion) */
const PRICE_FETCH_INTERVAL_MS = 30_000;

// ─── Known Exchange Addresses ───────────────────────────────────────────────
// Top exchange cold/hot wallets — partial list, covers majority of volume.
// These are well-known public addresses.

const EXCHANGE_ADDRESSES = new Set([
  // Binance
  '34xp4vRoCGJym3xR7yCVPFHoCNxv4Twseo',
  'bc1qm34lsc65zpw79lxes69zkqmk6ee3ewf0j77s3',
  '3M219KR5vEneNb47ewrPfWyb5jQ2DjxRP6',
  '1NDyJtNTjmwk5xPNhjgAMu4HDHigtobu1s',
  'bc1qgdjqv0av3q56jvd82tkdjpy7gdp9ut8tlqmgrpmv24sq90ecnvqqjwvw97',
  // Coinbase
  '3Kzh9qAqVWQhEsfQz7zEQL1EuSx5tyNLNS',
  'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh',
  '3FHNBLobJnbCTFTVax1t1GjRHQ5KSvogCP',
  // Kraken
  'bc1qx9t2l3pyny2spqpqlye8svce70nppwtaxwdrp4',
  '3AfSgTzDFCJJH74xPjSbJp8MJGxBzTWHHa',
  // Bitfinex
  'bc1qgp3"rl0rl6mm209lh989sj9ahw0yy0wlkwe89p9',
  '3D2oetdNuZUqQHPJmcMDDHYoqkyNVsFk9r',
  // Gemini
  '36PrZ1KHYMpqSyAQXSG8VwbUiq2EogxLo2',
  // OKX
  'bc1q2s3rjwvam9dt2ftt4sqxqjf3twav0gdx0k0q2etjz348p2t6y7ms2wlzln',
  // Bybit
  'bc1qjysjfd9t9aspttpjqzv68k0cc7ewvhzqeg3q09',
  // Bitget
  'bc1qm5jk8yaxvra4065hmvx9v7jeefd4yxkm4hrlqk',
]);

// ─── Service ────────────────────────────────────────────────────────────────

@Injectable()
export class WhaleTrackerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger: BrainLoggerService;
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private persistTimer: ReturnType<typeof setInterval> | null = null;
  private priceFetchTimer: ReturnType<typeof setInterval> | null = null;

  /** Rolling window of recent whale transactions */
  private recentTransactions: WhaleTransaction[] = [];

  /** Current computed features */
  private currentFeatures: WhaleFeatures = this.defaultFeatures();

  /** History buffer of snapshots */
  private snapshotHistory: Array<{ features: WhaleFeatures; eventTime: number }> = [];

  /** Baseline whale volume (rolling average for abnormality detection) */
  private baselineVolumeBtc = 0;
  private baselineSampleCount = 0;

  /** Current BTC price in USD for value estimation */
  private btcPriceUsd = 0;

  constructor(
    @Inject(DATABASE_CLIENT) private readonly db: DbClient,
    private readonly eventBus: EventBus,
    logger: BrainLoggerService,
  ) {
    this.logger = logger.child('WhaleTrackerService');
  }

  async onModuleInit(): Promise<void> {
    await this.fetchBtcPrice();
    this.connect();
    this.startPersistLoop();
    this.startPriceFetchLoop();
  }

  onModuleDestroy(): void {
    this.disconnect();
    this.stopPersistLoop();
    this.stopPriceFetchLoop();
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  getCurrentFeatures(): WhaleFeatures {
    return this.currentFeatures;
  }

  getRecentTransactions(limit = 20): WhaleTransaction[] {
    return this.recentTransactions.slice(-limit);
  }

  getHistory(limit = 50): Array<{ features: WhaleFeatures; eventTime: number }> {
    return this.snapshotHistory.slice(-limit);
  }

  getStatus(): { connected: boolean; transactionCount: number; btcPriceUsd: number } {
    return {
      connected: this.ws?.readyState === WebSocket.OPEN,
      transactionCount: this.recentTransactions.length,
      btcPriceUsd: this.btcPriceUsd,
    };
  }

  // ─── WebSocket Connection ─────────────────────────────────────────────────

  private connect(): void {
    this.logger.info('Connecting to mempool.space WebSocket', { url: MEMPOOL_WS_URL });

    try {
      this.ws = new WebSocket(MEMPOOL_WS_URL);
    } catch (err) {
      this.logger.error('Failed to create WebSocket', (err as Error).message);
      this.scheduleReconnect();
      return;
    }

    this.ws.on('open', () => {
      this.logger.info('Connected to mempool.space');
      this.reconnectAttempts = 0;

      // Subscribe to new transactions
      this.ws?.send(JSON.stringify({ action: 'want', data: ['mempool-blocks'] }));
    });

    this.ws.on('message', (data: WebSocket.Data) => {
      try {
        this.handleMessage(data.toString());
      } catch (err) {
        this.logger.debug('Failed to parse WebSocket message', { error: (err as Error).message });
      }
    });

    this.ws.on('close', () => {
      this.logger.warn('WebSocket disconnected');
      this.scheduleReconnect();
    });

    this.ws.on('error', (err: Error) => {
      this.logger.error('WebSocket error', err.message);
    });
  }

  private disconnect(): void {
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
    this.logger.info('Scheduling reconnect', { attempt: this.reconnectAttempts, delayMs: delay });

    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
  }

  // ─── Message Handling ─────────────────────────────────────────────────────

  private handleMessage(raw: string): void {
    const msg = JSON.parse(raw) as MempoolMessage;

    // mempool-blocks contains arrays of transactions grouped by fee rate
    if (msg['mempool-blocks']) {
      for (const block of msg['mempool-blocks']) {
        if (!block.transactions) continue;
        for (const tx of block.transactions) {
          this.processTransaction(tx);
        }
      }
    }

    // Also handle individual transaction broadcasts if available
    if (msg.tx) {
      this.processTransaction(msg.tx);
    }
  }

  private processTransaction(tx: MempoolTransaction): void {
    // Calculate total output value in BTC
    const totalValueBtc = (tx.value ?? 0) / 1e8;

    if (totalValueBtc < WHALE_THRESHOLD_BTC) return;

    // Detect exchange flow direction
    const isExchangeInflow = this.isExchangeAddress(tx.vout);
    const isExchangeOutflow = this.isExchangeAddress(tx.vin);

    let direction: WhaleTransaction['direction'] = 'unknown';
    if (isExchangeInflow && !isExchangeOutflow) direction = 'exchange_inflow';
    else if (isExchangeOutflow && !isExchangeInflow) direction = 'exchange_outflow';

    const whaleTx: WhaleTransaction = {
      txid: tx.txid ?? `unknown-${Date.now()}`,
      amountBtc: totalValueBtc,
      amountUsd: totalValueBtc * this.btcPriceUsd,
      direction,
      fromAddress: tx.vin?.[0]?.prevout?.scriptpubkey_address ?? 'unknown',
      toAddress: tx.vout?.[0]?.scriptpubkey_address ?? 'unknown',
      isExchangeInflow,
      isExchangeOutflow,
      eventTime: Date.now(),
    };

    this.recentTransactions.push(whaleTx);
    this.pruneOldTransactions();
    this.recomputeFeatures();

    // Emit event for large transactions
    this.emitEvent('whales.large-tx.detected', {
      txid: whaleTx.txid,
      amountBtc: whaleTx.amountBtc,
      direction: whaleTx.direction,
    });

    this.logger.info('Whale transaction detected', {
      txid: whaleTx.txid,
      amountBtc: whaleTx.amountBtc,
      direction: whaleTx.direction,
      amountUsd: Math.round(whaleTx.amountUsd),
    });
  }

  private isExchangeAddress(ios: MempoolVin[] | MempoolVout[] | undefined): boolean {
    if (!ios) return false;
    for (const io of ios) {
      let addr = '';
      if ('prevout' in io) {
        addr = (io as MempoolVin).prevout?.scriptpubkey_address ?? '';
      } else {
        addr = (io as MempoolVout).scriptpubkey_address ?? '';
      }
      if (EXCHANGE_ADDRESSES.has(addr)) return true;
    }
    return false;
  }

  // ─── Feature Computation ──────────────────────────────────────────────────

  private recomputeFeatures(): void {
    const txs = this.recentTransactions;

    if (txs.length === 0) {
      this.currentFeatures = this.defaultFeatures();
      return;
    }

    const largeTransactionCount = txs.length;
    const whaleVolumeBtc = txs.reduce((sum, tx) => sum + tx.amountBtc, 0);

    // Net exchange flow: inflows are positive (bearish), outflows are negative (bullish)
    let netExchangeFlowBtc = 0;
    for (const tx of txs) {
      if (tx.isExchangeInflow) netExchangeFlowBtc += tx.amountBtc;
      if (tx.isExchangeOutflow) netExchangeFlowBtc -= tx.amountBtc;
    }

    // Normalize exchange flow pressure to -1..1
    // Use 100 BTC as the reference scale (significant but not extreme)
    const exchangeFlowPressure = Math.max(-1, Math.min(1, netExchangeFlowBtc / 100));

    // Abnormal activity score: compare current volume to rolling baseline
    this.updateBaseline(whaleVolumeBtc);
    const abnormalActivityScore =
      this.baselineVolumeBtc > 0
        ? Math.min(1, whaleVolumeBtc / (this.baselineVolumeBtc * 3)) // 3x baseline = score 1.0
        : whaleVolumeBtc > 0
          ? 0.5
          : 0;

    const lastTx = txs[txs.length - 1];

    this.currentFeatures = {
      largeTransactionCount,
      netExchangeFlowBtc: round(netExchangeFlowBtc, 4),
      exchangeFlowPressure: round(exchangeFlowPressure, 4),
      whaleVolumeBtc: round(whaleVolumeBtc, 4),
      abnormalActivityScore: round(abnormalActivityScore, 4),
      lastWhaleEventTime: lastTx?.eventTime ?? null,
    };

    this.emitEvent('whales.flow.updated', {
      netExchangeFlowBtc: this.currentFeatures.netExchangeFlowBtc,
      exchangeFlowPressure: this.currentFeatures.exchangeFlowPressure,
      abnormalActivityScore: this.currentFeatures.abnormalActivityScore,
    });
  }

  private updateBaseline(currentVolume: number): void {
    // Exponential moving average of whale volume
    this.baselineSampleCount++;
    const alpha = Math.min(0.1, 2 / (this.baselineSampleCount + 1));
    this.baselineVolumeBtc = this.baselineVolumeBtc * (1 - alpha) + currentVolume * alpha;
  }

  private pruneOldTransactions(): void {
    const cutoff = Date.now() - ROLLING_WINDOW_MS;
    this.recentTransactions = this.recentTransactions.filter((tx) => tx.eventTime > cutoff);
  }

  private defaultFeatures(): WhaleFeatures {
    return {
      largeTransactionCount: 0,
      netExchangeFlowBtc: 0,
      exchangeFlowPressure: 0,
      whaleVolumeBtc: 0,
      abnormalActivityScore: 0,
      lastWhaleEventTime: null,
    };
  }

  // ─── BTC Price Fetching ───────────────────────────────────────────────────

  private async fetchBtcPrice(): Promise<void> {
    try {
      const res = await fetch('https://mempool.space/api/v1/prices');
      const data = (await res.json()) as { USD?: number };
      if (data.USD) {
        this.btcPriceUsd = data.USD;
        this.logger.debug('BTC price updated', { usd: this.btcPriceUsd });
      }
    } catch {
      // Try price-feed service as fallback
      try {
        const priceServiceUrl = process.env.PRICE_SERVICE_URL ?? 'http://localhost:3002';
        const res = await fetch(`${priceServiceUrl}/api/v1/price/current`);
        const json = (await res.json()) as { ok: boolean; data?: { resolver?: { price: number } } };
        if (json.ok && json.data?.resolver?.price) {
          this.btcPriceUsd = json.data.resolver.price;
        }
      } catch {
        /* use last known price */
      }
    }
  }

  private startPriceFetchLoop(): void {
    this.priceFetchTimer = setInterval(async () => {
      await this.fetchBtcPrice();
    }, PRICE_FETCH_INTERVAL_MS);
  }

  private stopPriceFetchLoop(): void {
    if (this.priceFetchTimer) {
      clearInterval(this.priceFetchTimer);
      this.priceFetchTimer = null;
    }
  }

  // ─── Persistence ──────────────────────────────────────────────────────────

  private startPersistLoop(): void {
    this.persistTimer = setInterval(async () => {
      this.pruneOldTransactions();
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
    const features = this.currentFeatures;

    // Store in history buffer
    this.snapshotHistory.push({ features, eventTime: now });
    if (this.snapshotHistory.length > HISTORY_BUFFER_SIZE) {
      this.snapshotHistory = this.snapshotHistory.slice(-HISTORY_BUFFER_SIZE);
    }

    // Persist to database
    try {
      await this.db.insert(whaleSnapshots).values({
        windowId: 'rolling',
        largeTransactionCount: features.largeTransactionCount,
        netExchangeFlowBtc: features.netExchangeFlowBtc,
        exchangeFlowPressure: features.exchangeFlowPressure,
        whaleVolumeBtc: features.whaleVolumeBtc,
        abnormalActivityScore: features.abnormalActivityScore,
        recentTransactions: this.recentTransactions.slice(-10) as unknown as Array<
          Record<string, unknown>
        >,
        eventTime: now,
        ingestedAt: now,
      });
    } catch {
      /* best-effort persistence */
    }
  }

  /** Returns the last N snapshots from the database */
  async getPersistedHistory(limit = 50): Promise<Array<Record<string, unknown>>> {
    const rows = await this.db
      .select()
      .from(whaleSnapshots)
      .orderBy(desc(whaleSnapshots.eventTime))
      .limit(limit);
    return rows;
  }

  // ─── Utilities ────────────────────────────────────────────────────────────

  private emitEvent<E extends BrainEventName>(event: E, payload: BrainEventMap[E]): void {
    this.eventBus.emit(event, payload);
  }
}

// ─── Mempool.space WebSocket Types ──────────────────────────────────────────

interface MempoolVout {
  scriptpubkey_address?: string;
  value?: number;
}

interface MempoolVin {
  prevout?: {
    scriptpubkey_address?: string;
    value?: number;
  };
}

interface MempoolTransaction {
  txid?: string;
  value?: number;
  vin?: MempoolVin[];
  vout?: MempoolVout[];
}

interface MempoolBlock {
  transactions?: MempoolTransaction[];
}

interface MempoolMessage {
  'mempool-blocks'?: MempoolBlock[];
  tx?: MempoolTransaction;
}

// ─── Utility ────────────────────────────────────────────────────────────────

function round(value: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
