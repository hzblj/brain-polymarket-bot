import { DatabaseModule } from '@brain/database';
import { EventBusModule } from '@brain/events';
import { Module } from '@nestjs/common';
import { ConfigManagementModule } from './config-management.module';

@Module({
  imports: [EventBusModule, DatabaseModule.forRoot(), ConfigManagementModule],
})
export class AppModule {}
