import { Module } from '@nestjs/common';
import { MarketDiscoveryController } from './market-discovery.controller';
import { MarketDiscoveryService } from './market-discovery.service';

@Module({
  controllers: [MarketDiscoveryController],
  providers: [MarketDiscoveryService],
  exports: [MarketDiscoveryService],
})
export class MarketDiscoveryModule {}
