import { BrainLoggerService } from '@brain/logger';
import { type DynamicModule, Module } from '@nestjs/common';
import { PolymarketClobClient, type ClobClientOptions } from './clob-client';
import { PolymarketRestClient, type PolymarketRestClientOptions } from './rest-client';
import { PolymarketWsClient, type PolymarketWsClientOptions } from './ws-client';

export interface PolymarketClientModuleOptions {
  apiUrl: string;
  wsUrl: string;
  chainId?: number;
  privateKey?: string;
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

    const providers: DynamicModule['providers'] = [
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
    ];

    // Only create CLOB client if private key is available (needed for signing orders)
    if (options.privateKey) {
      const clobOptions: ClobClientOptions = {
        apiUrl: options.apiUrl,
        chainId: options.chainId ?? 137, // Polygon mainnet
        privateKey: options.privateKey,
        apiKey: options.apiKey,
        apiSecret: options.apiSecret,
        apiPassphrase: options.apiPassphrase,
      };

      providers.push({
        provide: PolymarketClobClient,
        inject: [BrainLoggerService],
        useFactory: (logger: BrainLoggerService) => new PolymarketClobClient(clobOptions, logger),
      });
    }

    const exports = [PolymarketRestClient, PolymarketWsClient];
    if (options.privateKey) {
      exports.push(PolymarketClobClient as any);
    }

    return {
      module: PolymarketClientModule,
      global: true,
      providers,
      exports,
    };
  }
}
