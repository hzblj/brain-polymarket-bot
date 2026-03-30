import { DatabaseModule } from '@brain/database';
import { Module } from '@nestjs/common';
import { FeatureEngineModule } from './feature-engine.module';

@Module({
  imports: [DatabaseModule.forRoot(), FeatureEngineModule],
})
export class AppModule {}
