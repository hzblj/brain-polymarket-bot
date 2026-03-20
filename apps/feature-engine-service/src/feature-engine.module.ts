import { Module } from '@nestjs/common';
import { FeatureEngineController } from './feature-engine.controller';
import { FeatureEngineService } from './feature-engine.service';

@Module({
  controllers: [FeatureEngineController],
  providers: [FeatureEngineService],
  exports: [FeatureEngineService],
})
export class FeatureEngineModule {}
