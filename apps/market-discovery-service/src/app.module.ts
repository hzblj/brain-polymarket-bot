import { DatabaseModule } from '@brain/database';
import { EventBusModule } from '@brain/events';
import { Module } from '@nestjs/common';
import { MarketDiscoveryModule } from './market-discovery.module';

@Module({
  imports: [EventBusModule, DatabaseModule.forRoot(), MarketDiscoveryModule],
})
export class AppModule {}
