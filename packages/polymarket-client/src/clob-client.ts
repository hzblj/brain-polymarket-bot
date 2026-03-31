import type { BrainLoggerService } from '@brain/logger';
import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { ClobClient, Side } from '@polymarket/clob-client';
import { ethers } from 'ethers';

export interface ClobClientOptions {
  apiUrl: string;
  chainId: number;
  privateKey: string;
  apiKey?: string;
  apiSecret?: string;
  apiPassphrase?: string;
}

export interface PlaceOrderParams {
  tokenId: string;
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
}

export interface OrderResult {
  success: boolean;
  orderId?: string;
  status?: string;
  errorMsg?: string;
  transacting?: boolean;
}

export interface MarketOutcome {
  conditionId: string;
  resolved: boolean;
  winner?: string; // token_id of winning outcome
  tokens: Array<{
    token_id: string;
    outcome: string;
    winner: boolean;
  }>;
}

@Injectable()
export class PolymarketClobClient implements OnModuleDestroy {
  private readonly clob: ClobClient;
  private readonly logger: BrainLoggerService;
  private readonly wallet: ethers.Wallet;

  constructor(options: ClobClientOptions, logger: BrainLoggerService) {
    this.logger = logger.child('PolymarketClobClient');

    this.wallet = new ethers.Wallet(options.privateKey);
    this.logger.info('Wallet initialized', { address: this.wallet.address });

    this.clob = new ClobClient(
      options.apiUrl,
      options.chainId,
      this.wallet,
      options.apiKey ? {
        key: options.apiKey,
        secret: options.apiSecret ?? '',
        passphrase: options.apiPassphrase ?? '',
      } : undefined,
    );
  }

  getWalletAddress(): string {
    return this.wallet.address;
  }

  /**
   * Place a signed limit order on Polymarket CLOB.
   */
  async placeOrder(params: PlaceOrderParams): Promise<OrderResult> {
    try {
      this.logger.info('Placing signed order', {
        tokenId: params.tokenId.slice(0, 20) + '...',
        side: params.side,
        price: params.price,
        size: params.size,
      });

      // Create, sign and submit order in one call
      const result = await this.clob.createAndPostOrder({
        tokenID: params.tokenId,
        side: params.side === 'BUY' ? Side.BUY : Side.SELL,
        price: params.price,
        size: params.size,
      });

      this.logger.info('Order submitted', {
        success: result.success,
        orderId: result.orderID,
        status: result.status,
      });

      return {
        success: result.success ?? false,
        orderId: result.orderID,
        status: result.status,
        transacting: result.transactioning,
      };
    } catch (error) {
      const msg = (error as Error).message;
      this.logger.error('Order placement failed', msg);
      return {
        success: false,
        errorMsg: msg,
      };
    }
  }

  /**
   * Cancel an order by ID.
   */
  async cancelOrder(orderId: string): Promise<boolean> {
    try {
      await this.clob.cancelOrder({ orderID: orderId });
      this.logger.info('Order cancelled', { orderId });
      return true;
    } catch (error) {
      this.logger.error('Cancel failed', (error as Error).message);
      return false;
    }
  }

  /**
   * Cancel all open orders.
   */
  async cancelAll(): Promise<boolean> {
    try {
      await this.clob.cancelAll();
      this.logger.info('All orders cancelled');
      return true;
    } catch (error) {
      this.logger.error('Cancel all failed', (error as Error).message);
      return false;
    }
  }

  /**
   * Get open orders for this wallet.
   */
  async getOpenOrders(): Promise<unknown[]> {
    try {
      const orders = await this.clob.getOpenOrders();
      return orders as unknown[];
    } catch {
      return [];
    }
  }

  /**
   * Check market resolution status.
   */
  async getMarketOutcome(conditionId: string): Promise<MarketOutcome | null> {
    try {
      const market = await this.clob.getMarket(conditionId);
      if (!market) return null;

      const tokens = (market.tokens ?? []).map((t: { token_id: string; outcome: string; winner: boolean }) => ({
        token_id: t.token_id,
        outcome: t.outcome,
        winner: t.winner,
      }));

      const resolved = tokens.some((t: { winner: boolean }) => t.winner);
      const winner = tokens.find((t: { winner: boolean }) => t.winner);

      return {
        conditionId,
        resolved,
        winner: winner?.token_id,
        tokens,
      };
    } catch {
      return null;
    }
  }

  onModuleDestroy(): void {
    this.logger.debug('PolymarketClobClient shutting down');
  }
}
