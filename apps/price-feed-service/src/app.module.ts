import { DatabaseModule } from '@brain/database';
import { Module } from '@nestjs/common';
import { PriceFeedModule } from './price-feed.module';

@Module({
  imports: [DatabaseModule.forRoot(), PriceFeedModule],
})
export class AppModule {}
