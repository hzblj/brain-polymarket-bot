import { Injectable, OnModuleDestroy } from '@nestjs/common';
import axios, { AxiosInstance, AxiosError } from 'axios';
import { BrainLoggerService } from '@brain/logger';
import type {
  PolymarketMarket,
  PolymarketOrderbook,
  PolymarketOrderRequest,
  PolymarketOrderResponse,
  PolymarketTradeResponse,
} from './types';

export interface PolymarketRestClientOptions {
  apiUrl: string;
  apiKey?: string;
  apiSecret?: string;
  apiPassphrase?: string;
  timeoutMs?: number;
}

@Injectable()
export class PolymarketRestClient implements OnModuleDestroy {
  private readonly client: AxiosInstance;
  private readonly logger: BrainLoggerService;

  constructor(
    private readonly options: PolymarketRestClientOptions,
    logger: BrainLoggerService,
  ) {
    this.logger = logger.child('PolymarketRestClient');

    this.client = axios.create({
      baseURL: options.apiUrl,
      timeout: options.timeoutMs ?? 10000,
      headers: {
        'Content-Type': 'application/json',
        ...(options.apiKey ? { 'POLY_API_KEY': options.apiKey } : {}),
        ...(options.apiSecret ? { 'POLY_API_SECRET': options.apiSecret } : {}),
        ...(options.apiPassphrase ? { 'POLY_PASSPHRASE': options.apiPassphrase } : {}),
      },
    });

    this.client.interceptors.response.use(
      (response) => response,
      (error: AxiosError) => {
        this.logger.error('Polymarket API error', undefined, {
          status: error.response?.status,
          url: error.config?.url,
          message: error.message,
          data: error.response?.data,
        });
        throw error;
      },
    );
  }

  async getMarket(conditionId: string): Promise<PolymarketMarket> {
    this.logger.debug('Fetching market', { conditionId });
    const response = await this.client.get<PolymarketMarket>(`/markets/${conditionId}`);
    return response.data;
  }

  async getMarkets(params?: { next_cursor?: string; limit?: number }): Promise<{ data: PolymarketMarket[]; next_cursor: string }> {
    const response = await this.client.get('/markets', { params });
    return response.data;
  }

  async getOrderbook(tokenId: string): Promise<PolymarketOrderbook> {
    this.logger.debug('Fetching orderbook', { tokenId });
    const response = await this.client.get<PolymarketOrderbook>(`/book`, {
      params: { token_id: tokenId },
    });
    return response.data;
  }

  async placeOrder(order: PolymarketOrderRequest): Promise<PolymarketOrderResponse> {
    this.logger.info('Placing order', {
      tokenID: order.tokenID,
      side: order.side,
      price: order.price,
      size: order.size,
    });
    const response = await this.client.post<PolymarketOrderResponse>('/order', order);
    this.logger.info('Order placed', { orderId: response.data.id, status: response.data.status });
    return response.data;
  }

  async cancelOrder(orderId: string): Promise<void> {
    this.logger.info('Cancelling order', { orderId });
    await this.client.delete(`/order/${orderId}`);
    this.logger.info('Order cancelled', { orderId });
  }

  async cancelAllOrders(marketId?: string): Promise<void> {
    this.logger.info('Cancelling all orders', { marketId });
    await this.client.delete('/orders', {
      params: marketId ? { market: marketId } : undefined,
    });
  }

  async getOpenOrders(params?: { market?: string; asset_id?: string }): Promise<PolymarketOrderResponse[]> {
    const response = await this.client.get<PolymarketOrderResponse[]>('/orders', { params });
    return response.data;
  }

  async getTrades(params?: { market?: string; maker_address?: string }): Promise<PolymarketTradeResponse[]> {
    const response = await this.client.get<PolymarketTradeResponse[]>('/trades', { params });
    return response.data;
  }

  onModuleDestroy(): void {
    // Axios doesn't need explicit cleanup, but we log shutdown
    this.logger.debug('PolymarketRestClient shutting down');
  }
}
