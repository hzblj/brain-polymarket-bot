import { EventBusModule } from '@brain/events';
import { Module } from '@nestjs/common';
import { PipelineModule } from './pipeline.module';

@Module({
  imports: [EventBusModule, PipelineModule],
})
export class AppModule {}
