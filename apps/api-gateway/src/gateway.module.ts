import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';
import { GatewayController } from './gateway.controller';
import { GatewayService } from './gateway.service';

@Module({
  imports: [
    HttpModule.register({
      timeout: 30_000,
      maxRedirects: 3,
    }),
  ],
  controllers: [GatewayController, DashboardController],
  providers: [GatewayService, DashboardService],
  exports: [GatewayService],
})
export class GatewayModule {}
