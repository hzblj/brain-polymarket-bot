import { EventBusModule } from '@brain/events';
import { Module } from '@nestjs/common';
import { FeatureEngineController } from './feature-engine.controller';
import { FeatureEngineService } from './feature-engine.service';

@Module({
  imports: [EventBusModule],
  controllers: [FeatureEngineController],
  providers: [FeatureEngineService],
  exports: [FeatureEngineService],
})
export class FeatureEngineModule {}
