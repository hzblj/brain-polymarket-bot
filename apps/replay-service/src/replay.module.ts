import { Module } from '@nestjs/common';
import { ReplayController } from './replay.controller';
import { ReplayService } from './replay.service';

@Module({
  controllers: [ReplayController],
  providers: [ReplayService],
  exports: [ReplayService],
})
export class ReplayModule {}
