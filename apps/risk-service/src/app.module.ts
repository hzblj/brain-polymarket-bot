import { DatabaseModule } from '@brain/database';
import { EventBusModule } from '@brain/events';
import { Module } from '@nestjs/common';
import { RiskModule } from './risk.module';

@Module({
  imports: [EventBusModule, DatabaseModule.forRoot(), RiskModule],
})
export class AppModule {}
