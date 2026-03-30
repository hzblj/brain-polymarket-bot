import { DatabaseModule } from '@brain/database';
import { EventBusModule } from '@brain/events';
import { Module } from '@nestjs/common';
import { FeatureEngineModule } from './feature-engine.module';

@Module({
  imports: [EventBusModule, DatabaseModule.forRoot(), FeatureEngineModule],
})
export class AppModule {}
