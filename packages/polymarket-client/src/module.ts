import { DynamicModule, Module } from '@nestjs/common';
import { BrainLoggerService } from '@brain/logger';
import { PolymarketRestClient, type PolymarketRestClientOptions } from './rest-client';
import { PolymarketWsClient, type PolymarketWsClientOptions } from './ws-client';

export interface PolymarketClientModuleOptions {
  apiUrl: string;
  wsUrl: string;
  apiKey?: string;
  apiSecret?: string;
  apiPassphrase?: string;
  timeoutMs?: number;
  reconnectIntervalMs?: number;
  maxReconnectAttempts?: number;
}

@Module({})
export class PolymarketClientModule {
  static forRoot(options: PolymarketClientModuleOptions): DynamicModule {
    const restOptions: PolymarketRestClientOptions = {
      apiUrl: options.apiUrl,
      apiKey: options.apiKey,
      apiSecret: options.apiSecret,
      apiPassphrase: options.apiPassphrase,
      timeoutMs: options.timeoutMs,
    };

    const wsOptions: PolymarketWsClientOptions = {
      wsUrl: options.wsUrl,
      reconnectIntervalMs: options.reconnectIntervalMs,
      maxReconnectAttempts: options.maxReconnectAttempts,
    };

    return {
      module: PolymarketClientModule,
      global: true,
      providers: [
        {
          provide: PolymarketRestClient,
          inject: [BrainLoggerService],
          useFactory: (logger: BrainLoggerService) => new PolymarketRestClient(restOptions, logger),
        },
        {
          provide: PolymarketWsClient,
          inject: [BrainLoggerService],
          useFactory: (logger: BrainLoggerService) => new PolymarketWsClient(wsOptions, logger),
        },
      ],
      exports: [PolymarketRestClient, PolymarketWsClient],
    };
  }
}
