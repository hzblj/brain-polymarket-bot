import type { BrainLoggerService } from '@brain/logger';
import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import WebSocket from 'ws';
import type { PriceFeedClient, PriceFeedTick, PriceTickHandler } from './interface';

interface CoinbaseTickerMessage {
  type: 'ticker';
  product_id: string;
  price: string;
  best_bid: string;
  best_ask: string;
  time: string;
}

export interface CoinbaseClientOptions {
  wsUrl: string;
  productId: string;
  reconnectIntervalMs?: number;
  maxReconnectAttempts?: number;
}

@Injectable()
export class CoinbaseClient implements PriceFeedClient, OnModuleDestroy {
  readonly source = 'coinbase' as const;

  private ws: WebSocket | null = null;
  private readonly logger: BrainLoggerService;
  private handlers = new Set<PriceTickHandler>();
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldReconnect = true;

  private readonly wsUrl: string;
  private readonly productId: string;
  private readonly reconnectIntervalMs: number;
  private readonly maxReconnectAttempts: number;

  constructor(options: CoinbaseClientOptions, logger: BrainLoggerService) {
    this.logger = logger.child('CoinbaseClient');
    this.wsUrl = options.wsUrl;
    this.productId = options.productId;
    this.reconnectIntervalMs = options.reconnectIntervalMs ?? 5000;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? 10;
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  connect(): Promise<void> {
    if (this.isConnected) return Promise.resolve();
    this.shouldReconnect = true;

    return new Promise<void>((resolve, reject) => {
      this.logger.info('Connecting to Coinbase', { url: this.wsUrl });
      this.ws = new WebSocket(this.wsUrl);

      this.ws.on('open', () => {
        this.reconnectAttempts = 0;
        this.logger.info('Connected to Coinbase WebSocket');

        const subscribeMsg = JSON.stringify({
          type: 'subscribe',
          product_ids: [this.productId],
          channels: ['ticker'],
        });
        this.ws?.send(subscribeMsg);
        this.logger.debug('Subscribed to Coinbase ticker', { productId: this.productId });
        resolve();
      });

      this.ws.on('message', (data: WebSocket.Data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type !== 'ticker') return;

          const ticker = msg as CoinbaseTickerMessage;
          const bid = parseFloat(ticker.best_bid);
          const ask = parseFloat(ticker.best_ask);
          const tick: PriceFeedTick = {
            source: 'coinbase',
            price: parseFloat(ticker.price),
            bid,
            ask,
            eventTime: new Date(ticker.time).getTime(),
          };

          for (const handler of this.handlers) {
            try {
              handler(tick);
            } catch (err) {
              this.logger.error('Tick handler error', (err as Error).message);
            }
          }
        } catch (err) {
          this.logger.error('Failed to parse Coinbase message', (err as Error).message);
        }
      });

      this.ws.on('close', (code, reason) => {
        this.logger.warn('Coinbase WebSocket closed', { code, reason: reason.toString() });
        this.scheduleReconnect();
      });

      this.ws.on('error', (error) => {
        this.logger.error('Coinbase WebSocket error', (error as Error).message);
        if (this.reconnectAttempts === 0) {
          reject(error);
        }
      });
    });
  }

  disconnect(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close(1000, 'Client disconnect');
      this.ws = null;
    }
    this.handlers.clear();
    this.logger.info('Disconnected from Coinbase');
  }

  onTick(handler: PriceTickHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect) return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.logger.error('Max Coinbase reconnect attempts reached');
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectIntervalMs * Math.min(this.reconnectAttempts, 5);

    this.logger.info('Scheduling Coinbase reconnect', {
      attempt: this.reconnectAttempts,
      delayMs: delay,
    });

    this.reconnectTimer = setTimeout(() => {
      this.connect().catch((err) => {
        this.logger.error('Coinbase reconnect failed', (err as Error).message);
      });
    }, delay);
  }

  onModuleDestroy(): void {
    this.disconnect();
  }
}
