import { Module } from '@nestjs/common';
import { OrderbookModule } from './orderbook.module';

@Module({
  imports: [OrderbookModule],
})
export class AppModule {}
