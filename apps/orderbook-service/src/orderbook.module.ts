import { Module } from '@nestjs/common';
import { OrderbookController } from './orderbook.controller';
import { OrderbookService } from './orderbook.service';

@Module({
  controllers: [OrderbookController],
  providers: [OrderbookService],
  exports: [OrderbookService],
})
export class OrderbookModule {}
