import { Module } from '@nestjs/common';
import { PriceFeedModule } from './price-feed.module';

@Module({
  imports: [PriceFeedModule],
})
export class AppModule {}
