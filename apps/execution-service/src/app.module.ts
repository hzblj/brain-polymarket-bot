import { DatabaseModule } from '@brain/database';
import { EventBusModule } from '@brain/events';
import { LoggerModule } from '@brain/logger';
import { PolymarketClientModule } from '@brain/polymarket-client';
import { Module } from '@nestjs/common';
import { ExecutionModule } from './execution.module';

@Module({
  imports: [
    LoggerModule.forService('execution-service'),
    EventBusModule,
    DatabaseModule.forRoot(),
    PolymarketClientModule.forRoot({
      apiUrl: process.env.POLYMARKET_API_URL ?? 'https://clob.polymarket.com',
      wsUrl: process.env.POLYMARKET_WS_URL ?? 'wss://ws-subscriptions-clob.polymarket.com/ws',
      privateKey: process.env.POLYMARKET_PRIVATE_KEY,
      apiKey: process.env.POLYMARKET_API_KEY,
      apiSecret: process.env.POLYMARKET_API_SECRET,
      apiPassphrase: process.env.POLYMARKET_API_PASSPHRASE,
    }),
    ExecutionModule,
  ],
})
export class AppModule {}
