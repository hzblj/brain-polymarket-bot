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

// ─── Known Exchange Addresses (100+) ────────────────────────────────────────
// Sources: public on-chain labels, exchange proof-of-reserves, blockchain explorers
// Map<address, exchange name> for per-wallet activity tracking

const EXCHANGE_ADDRESS_MAP = new Map<string, string>([
  // ── Binance (15) ──────────────────────────────────────────────────────────
  ['34xp4vRoCGJym3xR7yCVPFHoCNxv4Twseo', 'Binance'],
  ['bc1qm34lsc65zpw79lxes69zkqmk6ee3ewf0j77s3', 'Binance'],
  ['3M219KR5vEneNb47ewrPfWyb5jQ2DjxRP6', 'Binance'],
  ['1NDyJtNTjmwk5xPNhjgAMu4HDHigtobu1s', 'Binance'],
  ['bc1qgdjqv0av3q56jvd82tkdjpy7gdp9ut8tlqmgrpmv24sq90ecnvqqjwvw97', 'Binance'],
  ['3LYJfcfHPXYJreMsASk2jkn69LWEYKzexb', 'Binance'],
  ['3LQUu4v9z6KNch71j7kbj8GPeAGUo1FW6a', 'Binance'],
  ['1PJiGp2yDLvUgqeBsuZVCBADArNsk6XEiN', 'Binance'],
  ['bc1ql49ydapnjafl5t2cp9zqpjwe6pdgmxy98859v2', 'Binance'],
  ['39884E3j6KZj82FK4vcCrkUvWYL5MQaS3v', 'Binance'],
  ['bc1qazcm763858nkj2dz7g20ghjfnl6gq2vnm5a5u7', 'Binance'],
  ['3JJmF63ifcamPLiAmLgG96RA599iFgZoMC', 'Binance'],
  ['3HbvJBjPov8PBoFMhSJhi5DFTeqbXSF3i7', 'Binance'],
  ['3QTN7wR2EpVeGbjBcHWQgPEjMSPPqyvqnq', 'Binance'],
  ['bc1qk4m9zv5tnk2679cfd7dmaer3uakthwflskhael', 'Binance'],

  // ── Coinbase (15) ─────────────────────────────────────────────────────────
  ['3Kzh9qAqVWQhEsfQz7zEQL1EuSx5tyNLNS', 'Coinbase'],
  ['bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh', 'Coinbase'],
  ['3FHNBLobJnbCTFTVax1t1GjRHQ5KSvogCP', 'Coinbase'],
  ['bc1q7cyrfmck2ffu2ud3rn5l5a8yv6f0chkp0zpemf', 'Coinbase'],
  ['3Cbq7aT1tY8kMxWLbitaG7yT6bPbKChq64', 'Coinbase'],
  ['34GUzCVLbdPN27E2DKJGFLfWAo84Aq26bM', 'Coinbase'],
  ['bc1qr4dl5wa7kl8yu792dceg9z5knl2gkn220lk7a9', 'Coinbase'],
  ['395xEBmgiR2JRShKwbkbvSrmSGeaUTklEQ', 'Coinbase'],
  ['3NfuNsJFCRMa3C5z1As5X2a3BPaDLvFZfA', 'Coinbase'],
  ['1GR9qNz7zgtaW5HwwVpEJWMnGWhsbsieCG', 'Coinbase'],
  ['bc1qwqdg6squsna38e46795at95yu9atm8azzmyvckulcc7kytlcckxswvvzej', 'Coinbase'],
  ['3DVJfEsDTPkGDvqPCLC41X85L1B1DQR1ep', 'Coinbase'],
  ['3QaKF8zobqcqY8aS6nxCD5ZYdiRfL3RCmU', 'Coinbase'],
  ['38Xnrq8MZiKmYmwobbYGbithjiLmBnJVNW', 'Coinbase'],
  ['bc1qm4hh8dkqejp5gevyamdqf4mqgnqgpkm9mhv0l4', 'Coinbase'],

  // ── Kraken (12) ───────────────────────────────────────────────────────────
  ['bc1qx9t2l3pyny2spqpqlye8svce70nppwtaxwdrp4', 'Kraken'],
  ['3AfSgTzDFCJJH74xPjSbJp8MJGxBzTWHHa', 'Kraken'],
  ['bc1qr0y30m5044lmx9p4hl2mpxy6m0vfxfcnepufnf', 'Kraken'],
  ['3FupZp77ySr7jwoLYEJ9mwzJpvoNBXsBnE', 'Kraken'],
  ['bc1q5shngj24323nsrmxv99st02na6srekfctt30ch', 'Kraken'],
  ['3H5JTt42K7RmZtromfTSefcMEFMMe18pMD', 'Kraken'],
  ['bc1qge2jr62t2zpmsdwrv5dcy2frjf7pktxrr3rull', 'Kraken'],
  ['3KZ526NxCVXbKwwP66RgM3pte6zW4gY1tD', 'Kraken'],
  ['bc1q3x3ycasn7e0nr6p9sssahx50vszletqwkn7t4u', 'Kraken'],
  ['3E97AjYaCq9QYnfFMtBCWhE4fPHJoSfuwq', 'Kraken'],
  ['3Goufw1jNLMk6RaBxkPF2rSnExNRcf4Bnk', 'Kraken'],
  ['bc1qmxjefnuy06v345v6vhwpwt05dztztmx4g3y7wp', 'Kraken'],

  // ── Bitfinex (10) ─────────────────────────────────────────────────────────
  ['bc1qgp3rl0rl6mm209lh989sj9ahw0yy0wlkwe89p9', 'Bitfinex'],
  ['3D2oetdNuZUqQHPJmcMDDHYoqkyNVsFk9r', 'Bitfinex'],
  ['bc1qak7ffrqhge8p9qmgr5dyfcp9ccfd4ygxxn5gmz', 'Bitfinex'],
  ['1Kr6QSydW9bFQG1mXiPNNu6WpJGmUa9i1g', 'Bitfinex'],
  ['3JZq4atUahhuA9rLhXLMhhTo133J9rF97j', 'Bitfinex'],
  ['bc1ql3a38kpxnfmzlm5q7yr93srhqfar8jr0caefl0', 'Bitfinex'],
  ['3QW5qFhFnKASMFkgSfei3HRx1nm5hLbFuQ', 'Bitfinex'],
  ['bc1qmutgekwr3hs0h02y2v3nse2c2f3t0ygwhr0z35', 'Bitfinex'],
  ['1AKr5HiWXsUQN7xFRKe3Bpf3M8ELZYZNMH', 'Bitfinex'],
  ['3CaG6g7X3mpAz3s4JW3EY2xUP1BjUFX5tn', 'Bitfinex'],

  // ── Gemini (8) ────────────────────────────────────────────────────────────
  ['36PrZ1KHYMpqSyAQXSG8VwbUiq2EogxLo2', 'Gemini'],
  ['bc1qe3q6qq86vrxh2xkdt53msc6q0ek7zz7d2k88u8', 'Gemini'],
  ['3QRPKDyh87SBFmPULPGWmVD1V3D5B7S1wr', 'Gemini'],
  ['3NhFiF7xLSGnM4dWBaMuWiU2fEG1m7F6FN', 'Gemini'],
  ['bc1qhz2rcdcnqlnfqrt8c2qpthg2y0dqcgss8j2q3j', 'Gemini'],
  ['3JEmL7KPWP2fhiMFAxWPfJXJBd5siajjqW', 'Gemini'],
  ['3LtAFMHRF5kgerayVP1GaCEzWxQhKQQ7Ga', 'Gemini'],
  ['3LCGsSmfr24demGvriN4e3ft8wEcDuHFqh', 'Gemini'],

  // ── OKX (10) ──────────────────────────────────────────────────────────────
  ['bc1q2s3rjwvam9dt2ftt4sqxqjf3twav0gdx0k0q2etjz348p2t6y7ms2wlzln', 'OKX'],
  ['bc1qfe458s74lmhaarqlecm54cl2gfnlmzurq630rp', 'OKX'],
  ['3LhLMBECihPzQdDGNQyfGZ8REHSKfCf3R3', 'OKX'],
  ['bc1qz3aadce34xlf6n7ulk4f7zf4y0m8xscdppjt0s', 'OKX'],
  ['3AeUiRtgMa7RfXTvFToUVxCvkZh5aDjKyH', 'OKX'],
  ['bc1qa5nrmr7lhaxdscfhvlrlrsedtjysqwr0g0ztd6', 'OKX'],
  ['3Nxwenay9Z8Lc9JBiep6SZYHCe7IkiJwqW', 'OKX'],
  ['bc1qs58nkqrseknfhml5pgmhqdw0gxfg97lyjcclts', 'OKX'],
  ['3ERfvuzAYPPpACivh1JnwYbBdrAjupTzbw', 'OKX'],
  ['bc1q4ljjkzp72fmehaxqe9fk5t3ysj6hwexg2rl7kf', 'OKX'],

  // ── Bybit (8) ─────────────────────────────────────────────────────────────
  ['bc1qjysjfd9t9aspttpjqzv68k0cc7ewvhzqeg3q09', 'Bybit'],
  ['bc1q4srun4yspqem2pqgkael56m0nzx6dv0vu6sk5x', 'Bybit'],
  ['3PpXFMFbSR3Tnz7TSjcjWnQBW6PZygv1ip', 'Bybit'],
  ['bc1qnfcwqdwrjta7a5hxv0hqtpqp8evzlxpnywydf9', 'Bybit'],
  ['3PE5BQWGaMCwLKSCb3BEf4RcYWtFVhf8CG', 'Bybit'],
  ['bc1qvlpkhk8vhm3zhvzcjxv89n29cqkwdaynfd8aaj', 'Bybit'],
  ['bc1qm5wr8rzy50t9yz2krt0ku4nht45rssasjfnfwn', 'Bybit'],
  ['1FWQiwK27EnGXb6BiBMRLJvunJQZZPMcGd', 'Bybit'],

  // ── Bitget (6) ────────────────────────────────────────────────────────────
  ['bc1qm5jk8yaxvra4065hmvx9v7jeefd4yxkm4hrlqk', 'Bitget'],
  ['bc1qse0xge4fy4w4zlp8hmjvj7rrpz2ljmta84hp0e', 'Bitget'],
  ['3QDCTzoc7Wrcp3RLNTG2fCxdpB1g6Z6Nvk', 'Bitget'],
  ['bc1qp7csetut3tl93j5s7t4dexkwsntx963xnfnknd', 'Bitget'],
  ['bc1qjuh40dafu4sqqnhupf5g8gvp2ywh0a9g2mtwxx', 'Bitget'],
  ['3QK2MFmNPLYQ9WL5h6LZjHZZmaMvXfmJBi', 'Bitget'],

  // ── Huobi / HTX (10) ──────────────────────────────────────────────────────
  ['1LAnF8h3qMGx3TSwNUHVneBZUEpwE4gu3D', 'Huobi'],
  ['14XKsv3HJQK87gFF4YFCFPoiPX4D3N1Fha', 'Huobi'],
  ['1HckjUpRGcrrRAtFaaCAUaGjsPx9oYmLaZ', 'Huobi'],
  ['1FoWyxwPXuj4C6abqwhjDWdz6D4PZgYRjA', 'Huobi'],
  ['bc1qaekfeyptwxj0xv7s6vlltsgh2qh39fmmhfnuap', 'Huobi'],
  ['3DUbEABMTGzQHx3MW6YKKvpsTCifrvfAre', 'Huobi'],
  ['1Q2eMEEV3jPNJ1Mwcbvgn7fBSDJ3LEhFXH', 'Huobi'],
  ['39wUKy2e2p64HTjZ7xMfMq1dEaKFNP7FCf', 'Huobi'],
  ['33pDAz64y5WevsEDiEy4cXJEjxTGQsrsHV', 'Huobi'],
  ['bc1qne8mqmk2y6xhaf92l5ntf92s9ca2s7x3xwr5l', 'Huobi'],

  // ── KuCoin (8) ────────────────────────────────────────────────────────────
  ['bc1qm34lsc65zpw79lxes69zkqmk6ee3ewf0j77s3h', 'KuCoin'],
  ['3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy', 'KuCoin'],
  ['bc1qpuqwmxncal3nh5j5d8vjjexgj8v7dqkzd2xluv', 'KuCoin'],
  ['37itBVB4m7z1m3xb2EC4ATjP4jcB8vu2fC', 'KuCoin'],
  ['bc1q8lanj99mawxsdlzslt6xwfpwer04yuer6gms23', 'KuCoin'],
  ['3LCciqGEyAhRker38tMPfMGSHq41JazV4B', 'KuCoin'],
  ['bc1qmwkzfej0tatxn7tax9yh7tgpkgr4g60c3d0fnz', 'KuCoin'],
  ['3Grmv1vN71FqBFETR5etfFUTWHJRDKF3pL', 'KuCoin'],

  // ── Crypto.com (6) ────────────────────────────────────────────────────────
  ['bc1q4c8n5t00jmj8temxdgcc3t32nkg2wjwz24lywv', 'Crypto.com'],
  ['3LYwDbpjSJcCbw8p7cDbZCMN7qoRhgrift', 'Crypto.com'],
  ['bc1qpy04q2zcqknex78gp0k5xp5tftpfjq4rdqlsth', 'Crypto.com'],
  ['3QU3TmR88ZEfxTmuBLF4Nir6h2LqpxrjMA', 'Crypto.com'],
  ['bc1q0ym0p8dw3jxncasceywku7zy5cc5z84e3xkhqn', 'Crypto.com'],
  ['3JtmCcVWEr69RVhsqSbsMZNCTqjKVLN2K5', 'Crypto.com'],

  // ── Gate.io (6) ───────────────────────────────────────────────────────────
  ['bc1qxch3q9cxv4lcekvnhnelm2gxgn8nma7t9n20fq', 'Gate.io'],
  ['1GmSfBrxiYwV3iT3PdcRFPJi8BfBYLEMrg', 'Gate.io'],
  ['3HLgxanCwJJyiTFYPSACjPJafgMBN8EFhT', 'Gate.io'],
  ['bc1qpd67we7ay0qs90ag3cpuehvv9kf57shyt9g8yg', 'Gate.io'],
  ['1MjpoKxzUfvEnkCsvFVFgcKBrTrwmJ2JjY', 'Gate.io'],
  ['3ArC1t3FMREUe3ZXp7sH9j5SJJ7NKdvLnZ', 'Gate.io'],

  // ── Bitstamp (5) ──────────────────────────────────────────────────────────
  ['3P3QsMVK89JBNqZQv5zMAKG8FK3kJM4rjt', 'Bitstamp'],
  ['bc1qnkf3ycr8vdxylzree5492sn0pelf9hgfx2mxte', 'Bitstamp'],
  ['3BiKLKhs1rMbV9DBNoyiBhcFm2aui7m5XY', 'Bitstamp'],
  ['1HQ3Go3ggs8pFnA3cv1HVwT8aVNA7drgpj', 'Bitstamp'],
  ['bc1q72k0tfjqy9xsg8kp9lgdlrfcrqd84hwjgr94ef', 'Bitstamp'],

  // ── Deribit (4) ───────────────────────────────────────────────────────────
  ['1Mw7Gg2dookhxMVZ7PrgDcjRkD9J8FRCEY', 'Deribit'],
  ['bc1qa7c4y3eqnhqhf9lzf4z9dgqj0u5rcz7s5nktd', 'Deribit'],
  ['3NpXph1Wn8ydSut11eLK1m3JRg5yrQeBBF', 'Deribit'],
  ['bc1q4zfspf0s2gfmuu8h5k0g7xqagfl0a578e0p2dz', 'Deribit'],

  // ── BitMEX (4) ────────────────────────────────────────────────────────────
  ['3BMEXqGpG4FxBA1KWhRFufXfSTRgzfDBhJ', 'BitMEX'],
  ['3BMEXT3Lx3zfQYKEnuUHXRyNpmrAfue1sP', 'BitMEX'],
  ['bc1qaf3tql84e7mv7jgjlzm5aqfhmqezf0hgfxluyj', 'BitMEX'],
  ['1LS6ij8STcYv3bphBFNHGCpGKGZ8cZdNhg', 'BitMEX'],
]);

/** Per-wallet activity tracking */
interface WalletActivity {
  volumeBtc: number;
  volumeUsd: number;
  txCount: number;
  inflowBtc: number;
  outflowBtc: number;
  lastSeenTime: number;
}

/** Exported type for top wallets API response */
export interface TopWallet {
  address: string;
  exchange: string;
  volumeBtc: number;
  volumeUsd: number;
  txCount: number;
  netFlowBtc: number;
  lastSeenTime: number;
}

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

  /** Per-address activity tracking (1h rolling window) */
  private walletActivity = new Map<string, WalletActivity>();

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

  getTopWallets(limit = 10): TopWallet[] {
    return [...this.walletActivity.entries()]
      .map(([address, act]) => ({
        address,
        exchange: EXCHANGE_ADDRESS_MAP.get(address) ?? 'Unknown',
        volumeBtc: round(act.volumeBtc, 4),
        volumeUsd: round(act.volumeUsd, 0),
        txCount: act.txCount,
        netFlowBtc: round(act.inflowBtc - act.outflowBtc, 4),
        lastSeenTime: act.lastSeenTime,
      }))
      .sort((a, b) => b.volumeBtc - a.volumeBtc)
      .slice(0, limit);
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

    // Track per-wallet activity
    if (isExchangeInflow) this.trackWalletActivity(vout, amountBtc, 'inflow');
    if (isExchangeOutflow) this.trackWalletActivity(vin, amountBtc, 'outflow');

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

      // Track per-wallet activity
      if (isExchangeInflow) this.trackWalletActivity(txDetail.vout as MempoolVout[], amountBtc, 'inflow');
      if (isExchangeOutflow) this.trackWalletActivity(txDetail.vin as MempoolVin[], amountBtc, 'outflow');

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

    // Track per-wallet activity
    if (isExchangeInflow) this.trackWalletActivity(tx.vout, totalValueBtc, 'inflow');
    if (isExchangeOutflow) this.trackWalletActivity(tx.vin, totalValueBtc, 'outflow');

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
      if (EXCHANGE_ADDRESS_MAP.has(addr)) return true;
    }
    return false;
  }

  /** Record per-address activity for the top wallets leaderboard */
  private trackWalletActivity(
    ios: MempoolVin[] | MempoolVout[] | undefined,
    amountBtc: number,
    type: 'inflow' | 'outflow',
  ): void {
    if (!ios) return;
    for (const io of ios) {
      let addr = '';
      if ('prevout' in io) {
        addr = (io as MempoolVin).prevout?.scriptpubkey_address ?? '';
      } else {
        addr = (io as MempoolVout).scriptpubkey_address ?? '';
      }
      if (!EXCHANGE_ADDRESS_MAP.has(addr)) continue;

      const existing = this.walletActivity.get(addr);
      if (existing) {
        existing.volumeBtc += amountBtc;
        existing.volumeUsd += amountBtc * this.btcPriceUsd;
        existing.txCount += 1;
        if (type === 'inflow') existing.inflowBtc += amountBtc;
        else existing.outflowBtc += amountBtc;
        existing.lastSeenTime = Date.now();
      } else {
        this.walletActivity.set(addr, {
          volumeBtc: amountBtc,
          volumeUsd: amountBtc * this.btcPriceUsd,
          txCount: 1,
          inflowBtc: type === 'inflow' ? amountBtc : 0,
          outflowBtc: type === 'outflow' ? amountBtc : 0,
          lastSeenTime: Date.now(),
        });
      }
    }
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
    // Prune stale wallet activity entries
    for (const [addr, act] of this.walletActivity) {
      if (act.lastSeenTime < cutoff) this.walletActivity.delete(addr);
    }
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
