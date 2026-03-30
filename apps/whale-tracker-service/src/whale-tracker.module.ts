import { Module } from '@nestjs/common';
import { WhaleTrackerController } from './whale-tracker.controller';
import { WhaleTrackerService } from './whale-tracker.service';

@Module({
  controllers: [WhaleTrackerController],
  providers: [WhaleTrackerService],
  exports: [WhaleTrackerService],
})
export class WhaleTrackerModule {}
