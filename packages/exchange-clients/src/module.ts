import { BrainLoggerService } from '@brain/logger';
import { type DynamicModule, Module } from '@nestjs/common';
import { BinanceClient, type BinanceClientOptions } from './binance-client';
import { CoinbaseClient, type CoinbaseClientOptions } from './coinbase-client';

export interface ExchangeClientsModuleOptions {
  binance: {
    wsUrl: string;
    symbol: string;
    reconnectIntervalMs?: number;
    maxReconnectAttempts?: number;
  };
  coinbase: {
    wsUrl: string;
    productId: string;
    reconnectIntervalMs?: number;
    maxReconnectAttempts?: number;
  };
}

@Module({})
export class ExchangeClientsModule {
  static forRoot(options: ExchangeClientsModuleOptions): DynamicModule {
    return {
      module: ExchangeClientsModule,
      global: true,
      providers: [
        {
          provide: BinanceClient,
          inject: [BrainLoggerService],
          useFactory: (logger: BrainLoggerService) =>
            new BinanceClient(options.binance as BinanceClientOptions, logger),
        },
        {
          provide: CoinbaseClient,
          inject: [BrainLoggerService],
          useFactory: (logger: BrainLoggerService) =>
            new CoinbaseClient(options.coinbase as CoinbaseClientOptions, logger),
        },
      ],
      exports: [BinanceClient, CoinbaseClient],
    };
  }
}
