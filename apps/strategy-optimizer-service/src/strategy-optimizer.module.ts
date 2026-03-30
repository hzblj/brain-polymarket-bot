import { Module } from '@nestjs/common';
import { StrategyOptimizerController } from './strategy-optimizer.controller';
import { StrategyOptimizerService } from './strategy-optimizer.service';

@Module({
  controllers: [StrategyOptimizerController],
  providers: [StrategyOptimizerService],
  exports: [StrategyOptimizerService],
})
export class StrategyOptimizerModule {}
