import { DatabaseModule } from '@brain/database';
import { Module } from '@nestjs/common';
import { ConfigManagementModule } from './config-management.module';

@Module({
  imports: [DatabaseModule.forRoot(), ConfigManagementModule],
})
export class AppModule {}
