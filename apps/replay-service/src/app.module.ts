import { DatabaseModule } from '@brain/database';
import { Module } from '@nestjs/common';
import { ReplayModule } from './replay.module';

@Module({
  imports: [DatabaseModule.forRoot(), ReplayModule],
})
export class AppModule {}
