import { DatabaseModule } from '@brain/database';
import { EventBusModule } from '@brain/events';
import { Module } from '@nestjs/common';
import { OrderbookModule } from './orderbook.module';

@Module({
  imports: [EventBusModule, DatabaseModule.forRoot(), OrderbookModule],
})
export class AppModule {}
