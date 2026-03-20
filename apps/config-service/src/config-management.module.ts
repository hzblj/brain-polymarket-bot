import { Module } from '@nestjs/common';
import { ConfigManagementController } from './config-management.controller';
import { ConfigManagementService } from './config-management.service';

@Module({
  controllers: [ConfigManagementController],
  providers: [ConfigManagementService],
  exports: [ConfigManagementService],
})
export class ConfigManagementModule {}
