import { Module } from '@nestjs/common';
import { FeatureEngineModule } from './feature-engine.module';

@Module({
  imports: [FeatureEngineModule],
})
export class AppModule {}
