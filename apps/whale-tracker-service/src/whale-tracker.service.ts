import { DATABASE_CLIENT, type DbClient, whaleSnapshots } from '@brain/database';
import { type BrainEventName, type BrainEventMap, EventBus } from '@brain/events';
import { BrainLoggerService } from '@brain/logger';
import type { BlockchainActivity, WhaleFeatures, WhaleFlowDirection, WhaleTransaction } from '@brain/types';
import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { desc } from 'drizzle-orm';
import WebSocket from 'ws';

// ─── Constants ──────────────────────────────────────────────────────────────

const MEMPOOL_WS_URL = process.env.MEMPOOL_WS_URL ?? 'wss://mempool.space/api/v1/ws';
const MEMPOOL_API_URL = process.env.MEMPOOL_API_URL ?? 'https://mempool.space';

/** Minimum BTC value to consider a transaction "whale-sized" */
const WHALE_THRESHOLD_BTC = parseFloat(process.env.WHALE_THRESHOLD_BTC ?? '10');

/** Minimum BTC to track as "notable" for blockchain activity */
const NOTABLE_THRESHOLD_BTC = parseFloat(process.env.NOTABLE_THRESHOLD_BTC ?? '1');

/** Rolling window: 1 hour for blockchain activity */
const BLOCKCHAIN_WINDOW_MS = 60 * 60 * 1000;

/** Rolling window: 5 minutes for whale features (trading window) */
const WHALE_WINDOW_MS = 5 * 60 * 1000;

/** REST polling interval for mempool stats & recent txs */
const BLOCKCHAIN_POLL_MS = 15_000;

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
  'bc1qgp3rl0rl6mm209lh989sj9ahw0yy0wlkwe89p9',
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

// ─── Mempool REST API Types ────────────────────────────────────────────────

interface MempoolStats {
  count: number;
  vsize: number;
  total_fee: number;
}

interface MempoolFees {
  fastestFee: number;
  halfHourFee: number;
  hourFee: number;
  economyFee: number;
  minimumFee: number;
}

interface MempoolRecentTx {
  txid: string;
  fee: number;
  vsize: number;
  value: number;
}

interface MempoolBlock {
  id: string;
  height: number;
  tx_count: number;
  size: number;
  timestamp: number;
}

// ─── Internal notable tx type ──────────────────────────────────────────────

interface NotableTx {
  txid: string;
  amountBtc: number;
  amountUsd: number;
  direction: WhaleFlowDirection;
  isExchangeInflow: boolean;
  isExchangeOutflow: boolean;
  eventTime: number;
}

// ─── Service ────────────────────────────────────────────────────────────────

@Injectable()
export class WhaleTrackerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger: BrainLoggerService;
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private persistTimer: ReturnType<typeof setInterval> | null = null;
  private priceFetchTimer: ReturnType<typeof setInterval> | null = null;
  private blockchainPollTimer: ReturnType<typeof setInterval> | null = null;

  /** Rolling window of recent whale transactions (5min, >10 BTC) */
  private recentTransactions: WhaleTransaction[] = [];

  /** Rolling 1h window of all notable transactions (>1 BTC) */
  private notableTransactions: NotableTx[] = [];

  /** Seen txids to avoid duplicates */
  private seenTxids = new Set<string>();

  /** Current computed features */
  private currentFeatures: WhaleFeatures = this.defaultFeatures();

  /** Current blockchain activity snapshot */
  private blockchainActivity: BlockchainActivity = this.defaultBlockchainActivity();

  /** Previous hour stats for trend calculation */
  private previousHourStats = { txCount: 0, volumeBtc: 0, avgFee: 0 };

  /** History buffer of snapshots */
  private snapshotHistory: Array<{ features: WhaleFeatures; eventTime: number }> = [];

  /** Baseline whale volume (rolling average for abnormality detection) */
  private baselineVolumeBtc = 0;
  private baselineSampleCount = 0;

  /** Current BTC price in USD for value estimation */
  private btcPriceUsd = 0;

  /** Cached mempool data */
  private mempoolStats: MempoolStats | null = null;
  private mempoolFees: MempoolFees | null = null;
  private latestBlock: MempoolBlock | null = null;

  constructor(
    @Inject(DATABASE_CLIENT) private readonly db: DbClient,
    @Inject(EventBus) private readonly eventBus: EventBus,
    @Inject(BrainLoggerService) logger: BrainLoggerService,
  ) {
    this.logger = logger.child('WhaleTrackerService');
  }

  async onModuleInit(): Promise<void> {
    await this.fetchBtcPrice();
    this.connect();
    this.startBlockchainPolling();
    this.startPersistLoop();
    this.startPriceFetchLoop();
    // Initial poll
    await this.pollBlockchainData();
  }

  onModuleDestroy(): void {
    this.disconnect();
    this.stopBlockchainPolling();
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

  getBlockchainActivity(): BlockchainActivity {
    return this.blockchainActivity;
  }

  /** LLM-ready summary of blockchain activity for the last hour */
  getLlmSummary(): string {
    const ba = this.blockchainActivity;
    const nt = ba.notableTransactions;
    const f = ba.fees;
    const m = ba.mempool;
    const t = ba.trend;

    const lines: string[] = [
      `=== Bitcoin Blockchain Activity (1h rolling window) ===`,
      `Time: ${new Date(ba.lastUpdated).toISOString()}`,
      `BTC Price: $${this.btcPriceUsd.toLocaleString()}`,
      ``,
      `--- Mempool ---`,
      `Pending transactions: ${m.txCount.toLocaleString()}`,
      `Mempool size: ${(m.vsize / 1_000_000).toFixed(1)} MvB`,
      `Total fees: ${m.totalFeeBtc.toFixed(4)} BTC`,
      ``,
      `--- Fee Rates (sat/vB) ---`,
      `Fastest: ${f.fastest} | 30min: ${f.halfHour} | 1h: ${f.hour} | Economy: ${f.economy}`,
      ``,
      `--- Notable Transactions (>1 BTC, last 1h) ---`,
      `Total: ${nt.total} transactions, ${nt.totalBtc.toFixed(2)} BTC ($${Math.round(nt.totalUsd).toLocaleString()})`,
      `Exchange inflows (bearish): ${nt.exchangeInflows.count} txs, ${nt.exchangeInflows.btc.toFixed(2)} BTC`,
      `Exchange outflows (bullish): ${nt.exchangeOutflows.count} txs, ${nt.exchangeOutflows.btc.toFixed(2)} BTC`,
    ];

    if (nt.largest) {
      lines.push(
        `Largest: ${nt.largest.amountBtc.toFixed(2)} BTC ($${Math.round(nt.largest.amountUsd).toLocaleString()}) [${nt.largest.direction}]`,
      );
    }

    if (ba.latestBlock) {
      lines.push(
        ``,
        `--- Latest Block ---`,
        `Height: ${ba.latestBlock.height} | Txs: ${ba.latestBlock.txCount} | Size: ${(ba.latestBlock.size / 1_000_000).toFixed(2)} MB`,
      );
    }

    lines.push(
      ``,
      `--- Trend vs Previous Hour ---`,
      `Tx count: ${t.txCountChange >= 0 ? '+' : ''}${t.txCountChange.toFixed(0)}%`,
      `Volume: ${t.volumeChange >= 0 ? '+' : ''}${t.volumeChange.toFixed(0)}%`,
      `Fees: ${t.feeChange >= 0 ? '+' : ''}${t.feeChange.toFixed(0)}%`,
    );

    // Signal interpretation
    const signals: string[] = [];
    if (nt.exchangeInflows.btc > nt.exchangeOutflows.btc * 2) {
      signals.push('BEARISH: Heavy exchange inflows (potential sell pressure)');
    } else if (nt.exchangeOutflows.btc > nt.exchangeInflows.btc * 2) {
      signals.push('BULLISH: Heavy exchange outflows (accumulation)');
    }
    if (f.fastest > 50) {
      signals.push('HIGH URGENCY: Fee rates elevated, high network demand');
    }
    if (t.volumeChange > 50) {
      signals.push('SPIKE: Volume significantly above previous hour');
    }
    if (nt.total === 0) {
      signals.push('QUIET: No notable transactions in the last hour');
    }

    if (signals.length > 0) {
      lines.push(``, `--- Signals ---`);
      for (const s of signals) lines.push(s);
    }

    return lines.join('\n');
  }

  getStatus() {
    return {
      connected: this.ws?.readyState === WebSocket.OPEN,
      transactionCount: this.recentTransactions.length,
      notableTransactionCount: this.notableTransactions.length,
      btcPriceUsd: this.btcPriceUsd,
      mempoolConnected: this.mempoolStats !== null,
      lastBlockchainPoll: this.blockchainActivity.lastUpdated,
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

      // Subscribe to mempool blocks and live transactions
      this.ws?.send(JSON.stringify({ action: 'want', data: ['mempool-blocks', 'blocks'] }));
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

  // ─── WS Message Handling ──────────────────────────────────────────────────

  private handleMessage(raw: string): void {
    const msg = JSON.parse(raw) as Record<string, unknown>;

    // mempool-blocks contains arrays of transactions grouped by fee rate
    if (msg['mempool-blocks'] && Array.isArray(msg['mempool-blocks'])) {
      for (const block of msg['mempool-blocks'] as MempoolWsBlock[]) {
        if (!block.transactions) continue;
        for (const tx of block.transactions) {
          this.processWsTransaction(tx);
        }
      }
    }

    // New block confirmed
    if (msg['block'] && typeof msg['block'] === 'object') {
      const block = msg['block'] as MempoolBlock;
      this.latestBlock = block;
      this.logger.info('New block', { height: block.height, txCount: block.tx_count });
    }
  }

  private processWsTransaction(tx: MempoolWsTransaction): void {
    const totalValueBtc = (tx.value ?? 0) / 1e8;

    // Track notable transactions (>1 BTC) for blockchain activity
    // WS mempool-blocks txs have limited data - pass vin/vout if available
    if (totalValueBtc >= NOTABLE_THRESHOLD_BTC) {
      const hasAddresses = tx.vin?.some(v => v.prevout?.scriptpubkey_address) ||
                           tx.vout?.some(v => v.scriptpubkey_address);
      this.addNotableTransaction(
        tx.txid ?? `ws-${Date.now()}`,
        totalValueBtc,
        hasAddresses ? tx.vin : undefined,
        hasAddresses ? tx.vout : undefined,
      );
    }

    // Track whale transactions (>10 BTC) separately
    if (totalValueBtc >= WHALE_THRESHOLD_BTC) {
      this.addWhaleTransaction(tx, totalValueBtc);
    }
  }

  // ─── REST Polling for Blockchain Data ─────────────────────────────────────

  private startBlockchainPolling(): void {
    this.blockchainPollTimer = setInterval(async () => {
      await this.pollBlockchainData();
    }, BLOCKCHAIN_POLL_MS);
  }

  private stopBlockchainPolling(): void {
    if (this.blockchainPollTimer) {
      clearInterval(this.blockchainPollTimer);
      this.blockchainPollTimer = null;
    }
  }

  async pollBlockchainData(): Promise<void> {
    try {
      const [stats, fees, recentTxs, blocks] = await Promise.all([
        this.fetchJson<MempoolStats>(`${MEMPOOL_API_URL}/api/mempool`),
        this.fetchJson<MempoolFees>(`${MEMPOOL_API_URL}/api/v1/fees/recommended`),
        this.fetchJson<MempoolRecentTx[]>(`${MEMPOOL_API_URL}/api/mempool/recent`),
        this.fetchJson<MempoolBlock[]>(`${MEMPOOL_API_URL}/api/v1/blocks`),
      ]);

      if (stats) this.mempoolStats = stats;
      if (fees) this.mempoolFees = fees;
      if (blocks && blocks.length > 0) this.latestBlock = blocks[0] ?? null;

      // Process recent mempool transactions
      if (recentTxs && Array.isArray(recentTxs)) {
        for (const tx of recentTxs) {
          const btcValue = tx.value / 1e8;
          if (btcValue >= NOTABLE_THRESHOLD_BTC && !this.seenTxids.has(tx.txid)) {
            this.addNotableTransaction(tx.txid, btcValue);
          }
        }
      }

      // Prune and recompute
      this.pruneNotableTransactions();
      this.recomputeBlockchainActivity();

      this.logger.debug('Blockchain data polled', {
        mempoolTxs: stats?.count ?? 0,
        notableTxs: this.notableTransactions.length,
        feeFastest: fees?.fastestFee ?? 0,
      });
    } catch (err) {
      this.logger.debug('Blockchain poll failed', { error: (err as Error).message });
    }
  }

  private async fetchJson<T>(url: string): Promise<T | null> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5_000);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) return null;
      return (await res.json()) as T;
    } catch {
      return null;
    }
  }

  // ─── Transaction Processing ───────────────────────────────────────────────

  private addNotableTransaction(
    txid: string,
    amountBtc: number,
    vin?: MempoolVin[],
    vout?: MempoolVout[],
  ): void {
    if (this.seenTxids.has(txid)) return;
    this.seenTxids.add(txid);

    // Cap seenTxids size
    if (this.seenTxids.size > 50_000) {
      const entries = [...this.seenTxids];
      this.seenTxids = new Set(entries.slice(-25_000));
    }

    let isExchangeInflow = this.isExchangeAddress(vout);
    let isExchangeOutflow = this.isExchangeAddress(vin);

    // If no vin/vout provided (from REST API) and tx is large enough, fetch full tx detail
    if (!vin && !vout && amountBtc >= 10) {
      this.enrichTransactionAsync(txid, amountBtc);
      return; // Will be added after enrichment
    }

    let direction: WhaleFlowDirection = 'unknown';
    if (isExchangeInflow && !isExchangeOutflow) direction = 'exchange_inflow';
    else if (isExchangeOutflow && !isExchangeInflow) direction = 'exchange_outflow';

    this.notableTransactions.push({
      txid,
      amountBtc,
      amountUsd: amountBtc * this.btcPriceUsd,
      direction,
      isExchangeInflow,
      isExchangeOutflow,
      eventTime: Date.now(),
    });
  }

  /** Fetch full tx details from mempool.space to detect exchange addresses */
  private async enrichTransactionAsync(txid: string, amountBtc: number): Promise<void> {
    try {
      const txDetail = await this.fetchJson<{
        txid: string;
        vin: Array<{ prevout?: { scriptpubkey_address?: string } }>;
        vout: Array<{ scriptpubkey_address?: string; value?: number }>;
      }>(`${MEMPOOL_API_URL}/api/tx/${txid}`);

      if (!txDetail) return;

      const isExchangeInflow = this.isExchangeAddress(txDetail.vout as MempoolVout[]);
      const isExchangeOutflow = this.isExchangeAddress(txDetail.vin as MempoolVin[]);

      let direction: WhaleFlowDirection = 'unknown';
      if (isExchangeInflow && !isExchangeOutflow) direction = 'exchange_inflow';
      else if (isExchangeOutflow && !isExchangeInflow) direction = 'exchange_outflow';

      this.notableTransactions.push({
        txid,
        amountBtc,
        amountUsd: amountBtc * this.btcPriceUsd,
        direction,
        isExchangeInflow,
        isExchangeOutflow,
        eventTime: Date.now(),
      });

      if (direction !== 'unknown') {
        this.logger.info('Exchange flow detected', { txid, amountBtc, direction });
      }
    } catch {
      // Best effort - add without enrichment
      this.notableTransactions.push({
        txid,
        amountBtc,
        amountUsd: amountBtc * this.btcPriceUsd,
        direction: 'unknown',
        isExchangeInflow: false,
        isExchangeOutflow: false,
        eventTime: Date.now(),
      });
    }
  }

  private addWhaleTransaction(tx: MempoolWsTransaction, totalValueBtc: number): void {
    const isExchangeInflow = this.isExchangeAddress(tx.vout);
    const isExchangeOutflow = this.isExchangeAddress(tx.vin);

    let direction: WhaleFlowDirection = 'unknown';
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
    this.pruneWhaleTransactions();
    this.recomputeFeatures();

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

  // ─── Blockchain Activity Computation ──────────────────────────────────────

  private recomputeBlockchainActivity(): void {
    const now = Date.now();
    const txs = this.notableTransactions;

    let totalBtc = 0;
    let inflowCount = 0;
    let inflowBtc = 0;
    let outflowCount = 0;
    let outflowBtc = 0;
    let largest: NotableTx | null = null;

    for (const tx of txs) {
      totalBtc += tx.amountBtc;
      if (tx.isExchangeInflow) {
        inflowCount++;
        inflowBtc += tx.amountBtc;
      }
      if (tx.isExchangeOutflow) {
        outflowCount++;
        outflowBtc += tx.amountBtc;
      }
      if (!largest || tx.amountBtc > largest.amountBtc) {
        largest = tx;
      }
    }

    const totalUsd = totalBtc * this.btcPriceUsd;

    // Compute trend vs previous hour
    const prevTx = this.previousHourStats.txCount;
    const prevVol = this.previousHourStats.volumeBtc;
    const prevFee = this.previousHourStats.avgFee;
    const currentFee = this.mempoolFees?.hourFee ?? 0;

    this.blockchainActivity = {
      window: {
        durationMs: BLOCKCHAIN_WINDOW_MS,
        startTime: now - BLOCKCHAIN_WINDOW_MS,
      },
      mempool: {
        txCount: this.mempoolStats?.count ?? 0,
        totalFeeBtc: (this.mempoolStats?.total_fee ?? 0) / 1e8,
        vsize: this.mempoolStats?.vsize ?? 0,
      },
      fees: {
        fastest: this.mempoolFees?.fastestFee ?? 0,
        halfHour: this.mempoolFees?.halfHourFee ?? 0,
        hour: this.mempoolFees?.hourFee ?? 0,
        economy: this.mempoolFees?.economyFee ?? 0,
        minimum: this.mempoolFees?.minimumFee ?? 0,
      },
      latestBlock: this.latestBlock
        ? {
            height: this.latestBlock.height,
            txCount: this.latestBlock.tx_count,
            size: this.latestBlock.size,
            timestamp: this.latestBlock.timestamp * 1000,
          }
        : null,
      notableTransactions: {
        total: txs.length,
        totalBtc: round(totalBtc, 4),
        totalUsd: round(totalUsd, 0),
        exchangeInflows: { count: inflowCount, btc: round(inflowBtc, 4) },
        exchangeOutflows: { count: outflowCount, btc: round(outflowBtc, 4) },
        largest: largest
          ? {
              txid: largest.txid,
              amountBtc: round(largest.amountBtc, 4),
              amountUsd: round(largest.amountUsd, 0),
              direction: largest.direction,
            }
          : null,
      },
      trend: {
        txCountChange: prevTx > 0 ? round(((txs.length - prevTx) / prevTx) * 100, 1) : 0,
        volumeChange: prevVol > 0 ? round(((totalBtc - prevVol) / prevVol) * 100, 1) : 0,
        feeChange: prevFee > 0 ? round(((currentFee - prevFee) / prevFee) * 100, 1) : 0,
      },
      lastUpdated: now,
    };

    // Rotate previous hour stats periodically
    if (this.baselineSampleCount % 240 === 0) {
      // ~every hour at 15s intervals
      this.previousHourStats = {
        txCount: txs.length,
        volumeBtc: totalBtc,
        avgFee: currentFee,
      };
    }
  }

  // ─── Whale Feature Computation ────────────────────────────────────────────

  private recomputeFeatures(): void {
    const txs = this.recentTransactions;

    if (txs.length === 0) {
      this.currentFeatures = this.defaultFeatures();
      return;
    }

    const largeTransactionCount = txs.length;
    const whaleVolumeBtc = txs.reduce((sum, tx) => sum + tx.amountBtc, 0);

    let netExchangeFlowBtc = 0;
    for (const tx of txs) {
      if (tx.isExchangeInflow) netExchangeFlowBtc += tx.amountBtc;
      if (tx.isExchangeOutflow) netExchangeFlowBtc -= tx.amountBtc;
    }

    const exchangeFlowPressure = Math.max(-1, Math.min(1, netExchangeFlowBtc / 100));

    this.updateBaseline(whaleVolumeBtc);
    const abnormalActivityScore =
      this.baselineVolumeBtc > 0
        ? Math.min(1, whaleVolumeBtc / (this.baselineVolumeBtc * 3))
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
    this.baselineSampleCount++;
    const alpha = Math.min(0.1, 2 / (this.baselineSampleCount + 1));
    this.baselineVolumeBtc = this.baselineVolumeBtc * (1 - alpha) + currentVolume * alpha;
  }

  private pruneWhaleTransactions(): void {
    const cutoff = Date.now() - WHALE_WINDOW_MS;
    this.recentTransactions = this.recentTransactions.filter((tx) => tx.eventTime > cutoff);
  }

  private pruneNotableTransactions(): void {
    const cutoff = Date.now() - BLOCKCHAIN_WINDOW_MS;
    this.notableTransactions = this.notableTransactions.filter((tx) => tx.eventTime > cutoff);
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

  private defaultBlockchainActivity(): BlockchainActivity {
    const now = Date.now();
    return {
      window: { durationMs: BLOCKCHAIN_WINDOW_MS, startTime: now - BLOCKCHAIN_WINDOW_MS },
      mempool: { txCount: 0, totalFeeBtc: 0, vsize: 0 },
      fees: { fastest: 0, halfHour: 0, hour: 0, economy: 0, minimum: 0 },
      latestBlock: null,
      notableTransactions: {
        total: 0,
        totalBtc: 0,
        totalUsd: 0,
        exchangeInflows: { count: 0, btc: 0 },
        exchangeOutflows: { count: 0, btc: 0 },
        largest: null,
      },
      trend: { txCountChange: 0, volumeChange: 0, feeChange: 0 },
      lastUpdated: now,
    };
  }

  // ─── BTC Price Fetching ───────────────────────────────────────────────────

  private async fetchBtcPrice(): Promise<void> {
    try {
      const res = await fetch(`${MEMPOOL_API_URL}/api/v1/prices`);
      const data = (await res.json()) as { USD?: number };
      if (data.USD) {
        this.btcPriceUsd = data.USD;
        this.logger.debug('BTC price updated', { usd: this.btcPriceUsd });
      }
    } catch {
      try {
        const priceServiceUrl = process.env.PRICE_SERVICE_URL ?? `http://${process.env.LOCAL_IP ?? 'localhost'}:3002`;
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
      this.pruneWhaleTransactions();
      this.pruneNotableTransactions();
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

    this.snapshotHistory.push({ features, eventTime: now });
    if (this.snapshotHistory.length > HISTORY_BUFFER_SIZE) {
      this.snapshotHistory = this.snapshotHistory.slice(-HISTORY_BUFFER_SIZE);
    }

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

interface MempoolWsTransaction {
  txid?: string;
  value?: number;
  vin?: MempoolVin[];
  vout?: MempoolVout[];
}

interface MempoolWsBlock {
  transactions?: MempoolWsTransaction[];
}

// ─── Utility ────────────────────────────────────────────────────────────────

function round(value: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
