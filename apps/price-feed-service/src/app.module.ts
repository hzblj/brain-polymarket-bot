import { DatabaseModule } from '@brain/database';
import { EventBusModule } from '@brain/events';
import { Module } from '@nestjs/common';
import { PriceFeedModule } from './price-feed.module';

@Module({
  imports: [EventBusModule, DatabaseModule.forRoot(), PriceFeedModule],
})
export class AppModule {}
