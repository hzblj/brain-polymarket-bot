import { DatabaseModule } from '@brain/database';
import { EventBusModule } from '@brain/events';
import { LoggerModule } from '@brain/logger';
import { Module } from '@nestjs/common';
import { WhaleTrackerModule } from './whale-tracker.module';

@Module({
  imports: [
    EventBusModule,
    LoggerModule.forService('whale-tracker'),
    DatabaseModule.forRoot(),
    WhaleTrackerModule,
  ],
})
export class AppModule {}
