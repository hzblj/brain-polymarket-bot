import { DatabaseModule } from '@brain/database';
import { Module } from '@nestjs/common';
import { ExecutionModule } from './execution.module';

@Module({
  imports: [DatabaseModule.forRoot(), ExecutionModule],
})
export class AppModule {}
