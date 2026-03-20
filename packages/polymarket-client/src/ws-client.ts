import { Injectable, OnModuleDestroy } from '@nestjs/common';
import WebSocket from 'ws';
import { BrainLoggerService } from '@brain/logger';
import type { PolymarketWsMessage, BookUpdateMessage } from './types';

export interface PolymarketWsClientOptions {
  wsUrl: string;
  reconnectIntervalMs?: number;
  maxReconnectAttempts?: number;
  pingIntervalMs?: number;
}

type BookUpdateHandler = (message: BookUpdateMessage) => void;

@Injectable()
export class PolymarketWsClient implements OnModuleDestroy {
  private ws: WebSocket | null = null;
  private readonly logger: BrainLoggerService;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private subscribedAssets = new Set<string>();
  private bookHandlers = new Map<string, Set<BookUpdateHandler>>();
  private isConnecting = false;
  private shouldReconnect = true;

  private readonly reconnectIntervalMs: number;
  private readonly maxReconnectAttempts: number;
  private readonly pingIntervalMs: number;

  constructor(
    private readonly options: PolymarketWsClientOptions,
    logger: BrainLoggerService,
  ) {
    this.logger = logger.child('PolymarketWsClient');
    this.reconnectIntervalMs = options.reconnectIntervalMs ?? 5000;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? 10;
    this.pingIntervalMs = options.pingIntervalMs ?? 30000;
  }

  async connect(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN || this.isConnecting) {
      return;
    }

    this.isConnecting = true;
    this.shouldReconnect = true;

    return new Promise<void>((resolve, reject) => {
      this.logger.info('Connecting to Polymarket WebSocket', { url: this.options.wsUrl });

      this.ws = new WebSocket(this.options.wsUrl);

      this.ws.on('open', () => {
        this.isConnecting = false;
        this.reconnectAttempts = 0;
        this.logger.info('Connected to Polymarket WebSocket');
        this.startPing();
        this.resubscribeAll();
        resolve();
      });

      this.ws.on('message', (data: WebSocket.Data) => {
        this.handleMessage(data);
      });

      this.ws.on('close', (code, reason) => {
        this.isConnecting = false;
        this.stopPing();
        this.logger.warn('WebSocket closed', { code, reason: reason.toString() });
        this.scheduleReconnect();
      });

      this.ws.on('error', (error) => {
        this.isConnecting = false;
        this.logger.error('WebSocket error', (error as Error).message);
        if (this.reconnectAttempts === 0) {
          reject(error);
        }
      });

      this.ws.on('pong', () => {
        this.logger.debug('Pong received');
      });
    });
  }

  subscribeBook(assetId: string, handler: BookUpdateHandler): () => void {
    this.subscribedAssets.add(assetId);

    if (!this.bookHandlers.has(assetId)) {
      this.bookHandlers.set(assetId, new Set());
    }
    this.bookHandlers.get(assetId)!.add(handler);

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.sendSubscription(assetId);
    }

    return () => {
      const handlers = this.bookHandlers.get(assetId);
      if (handlers) {
        handlers.delete(handler);
        if (handlers.size === 0) {
          this.bookHandlers.delete(assetId);
          this.subscribedAssets.delete(assetId);
          this.sendUnsubscription(assetId);
        }
      }
    };
  }

  disconnect(): void {
    this.shouldReconnect = false;
    this.stopPing();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close(1000, 'Client disconnect');
      this.ws = null;
    }
    this.subscribedAssets.clear();
    this.bookHandlers.clear();
    this.logger.info('Disconnected from Polymarket WebSocket');
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private handleMessage(data: WebSocket.Data): void {
    try {
      const messages: PolymarketWsMessage[] = JSON.parse(data.toString());
      const msgArray = Array.isArray(messages) ? messages : [messages];

      for (const msg of msgArray) {
        if (msg.event_type === 'book') {
          const bookMsg = msg as BookUpdateMessage;
          const handlers = this.bookHandlers.get(bookMsg.asset_id);
          if (handlers) {
            for (const handler of handlers) {
              try {
                handler(bookMsg);
              } catch (err) {
                this.logger.error('Book handler error', (err as Error).message);
              }
            }
          }
        }
      }
    } catch (err) {
      this.logger.error('Failed to parse WebSocket message', (err as Error).message);
    }
  }

  private sendSubscription(assetId: string): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;

    const message = JSON.stringify({
      type: 'subscribe',
      channel: 'book',
      assets_ids: [assetId],
    });

    this.ws.send(message);
    this.logger.debug('Subscribed to book updates', { assetId });
  }

  private sendUnsubscription(assetId: string): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;

    const message = JSON.stringify({
      type: 'unsubscribe',
      channel: 'book',
      assets_ids: [assetId],
    });

    this.ws.send(message);
    this.logger.debug('Unsubscribed from book updates', { assetId });
  }

  private resubscribeAll(): void {
    for (const assetId of this.subscribedAssets) {
      this.sendSubscription(assetId);
    }
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.ping();
      }
    }, this.pingIntervalMs);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect) return;

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.logger.error('Max reconnect attempts reached, giving up');
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectIntervalMs * Math.min(this.reconnectAttempts, 5);

    this.logger.info('Scheduling reconnect', {
      attempt: this.reconnectAttempts,
      delayMs: delay,
    });

    this.reconnectTimer = setTimeout(() => {
      this.connect().catch((err) => {
        this.logger.error('Reconnect failed', (err as Error).message);
      });
    }, delay);
  }

  onModuleDestroy(): void {
    this.disconnect();
  }
}
