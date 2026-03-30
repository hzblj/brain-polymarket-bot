import { DatabaseModule } from '@brain/database';
import { EventBusModule } from '@brain/events';
import { Module } from '@nestjs/common';
import { ExecutionModule } from './execution.module';

@Module({
  imports: [EventBusModule, DatabaseModule.forRoot(), ExecutionModule],
})
export class AppModule {}
