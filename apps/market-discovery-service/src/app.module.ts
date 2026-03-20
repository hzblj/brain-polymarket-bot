import { Module } from '@nestjs/common';
import { MarketDiscoveryModule } from './market-discovery.module';

@Module({
  imports: [MarketDiscoveryModule],
})
export class AppModule {}
