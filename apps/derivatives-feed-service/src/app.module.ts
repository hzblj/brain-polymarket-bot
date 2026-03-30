import { DatabaseModule } from '@brain/database';
import { EventBusModule } from '@brain/events';
import { LoggerModule } from '@brain/logger';
import { Module } from '@nestjs/common';
import { DerivativesFeedModule } from './derivatives-feed.module';

@Module({
  imports: [
    EventBusModule,
    LoggerModule.forService('derivatives-feed'),
    DatabaseModule.forRoot(),
    DerivativesFeedModule,
  ],
})
export class AppModule {}
