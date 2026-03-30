import { DatabaseModule } from '@brain/database';
import { Module } from '@nestjs/common';
import { OrderbookModule } from './orderbook.module';

@Module({
  imports: [DatabaseModule.forRoot(), OrderbookModule],
})
export class AppModule {}
