import { Module } from '@nestjs/common';
import { ConfigManagementModule } from './config-management.module';

@Module({
  imports: [ConfigManagementModule],
})
export class AppModule {}
