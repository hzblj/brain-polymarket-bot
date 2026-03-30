import type { BrainLoggerService } from '@brain/logger';
import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import WebSocket from 'ws';
import type { PriceFeedClient, PriceFeedTick, PriceTickHandler } from './interface';

interface BinanceTickerMessage {
  e: string; // event type
  E: number; // event time
  s: string; // symbol
  b: string; // best bid price
  B: string; // best bid qty
  a: string; // best ask price
  A: string; // best ask qty
}

export interface BinanceClientOptions {
  wsUrl: string;
  symbol: string;
  reconnectIntervalMs?: number;
  maxReconnectAttempts?: number;
}

@Injectable()
export class BinanceClient implements PriceFeedClient, OnModuleDestroy {
  readonly source = 'binance' as const;

  private ws: WebSocket | null = null;
  private readonly logger: BrainLoggerService;
  private handlers = new Set<PriceTickHandler>();
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldReconnect = true;

  private readonly wsUrl: string;
  private readonly symbol: string;
  private readonly reconnectIntervalMs: number;
  private readonly maxReconnectAttempts: number;

  constructor(options: BinanceClientOptions, logger: BrainLoggerService) {
    this.logger = logger.child('BinanceClient');
    this.wsUrl = options.wsUrl;
    this.symbol = options.symbol.toLowerCase();
    this.reconnectIntervalMs = options.reconnectIntervalMs ?? 5000;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? 10;
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  connect(): Promise<void> {
    if (this.isConnected) return Promise.resolve();
    this.shouldReconnect = true;

    const streamUrl = `${this.wsUrl}/${this.symbol}@bookTicker`;

    return new Promise<void>((resolve, reject) => {
      this.logger.info('Connecting to Binance', { url: streamUrl });
      this.ws = new WebSocket(streamUrl);

      this.ws.on('open', () => {
        this.reconnectAttempts = 0;
        this.logger.info('Connected to Binance WebSocket');
        resolve();
      });

      this.ws.on('message', (data: WebSocket.Data) => {
        try {
          const msg = JSON.parse(data.toString()) as BinanceTickerMessage;
          const bid = parseFloat(msg.b);
          const ask = parseFloat(msg.a);
          const tick: PriceFeedTick = {
            source: 'binance',
            price: (bid + ask) / 2,
            bid,
            ask,
            eventTime: msg.E,
          };

          for (const handler of this.handlers) {
            try {
              handler(tick);
            } catch (err) {
              this.logger.error('Tick handler error', (err as Error).message);
            }
          }
        } catch (err) {
          this.logger.error('Failed to parse Binance message', (err as Error).message);
        }
      });

      this.ws.on('close', (code, reason) => {
        this.logger.warn('Binance WebSocket closed', { code, reason: reason.toString() });
        this.scheduleReconnect();
      });

      this.ws.on('error', (error) => {
        this.logger.error('Binance WebSocket error', (error as Error).message);
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
    this.logger.info('Disconnected from Binance');
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
      this.logger.error('Max Binance reconnect attempts reached');
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectIntervalMs * Math.min(this.reconnectAttempts, 5);

    this.logger.info('Scheduling Binance reconnect', {
      attempt: this.reconnectAttempts,
      delayMs: delay,
    });

    this.reconnectTimer = setTimeout(() => {
      this.connect().catch((err) => {
        this.logger.error('Binance reconnect failed', (err as Error).message);
      });
    }, delay);
  }

  onModuleDestroy(): void {
    this.disconnect();
  }
}
