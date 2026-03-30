import { DatabaseModule } from '@brain/database';
import { Module } from '@nestjs/common';
import { MarketDiscoveryModule } from './market-discovery.module';

@Module({
  imports: [DatabaseModule.forRoot(), MarketDiscoveryModule],
})
export class AppModule {}
