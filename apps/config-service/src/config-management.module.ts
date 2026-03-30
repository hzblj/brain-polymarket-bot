import { Module } from '@nestjs/common';
import { ConfigManagementController, StrategyController } from './config-management.controller';
import { ConfigManagementService } from './config-management.service';
import { StrategyService } from './strategy.service';

@Module({
  controllers: [ConfigManagementController, StrategyController],
  providers: [ConfigManagementService, StrategyService],
  exports: [ConfigManagementService, StrategyService],
})
export class ConfigManagementModule {}
