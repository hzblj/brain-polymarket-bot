import { Controller, Get, Query } from '@nestjs/common';
import { DerivativesFeedService } from './derivatives-feed.service';

@Controller('api/v1/derivatives')
export class DerivativesFeedController {
  constructor(private readonly service: DerivativesFeedService) {}

  @Get('current')
  getCurrentFeatures() {
    return { ok: true, data: this.service.getCurrentFeatures() };
  }

  @Get('liquidations')
  getRecentLiquidations(@Query('limit') limit?: string) {
    const n = limit ? parseInt(limit, 10) : 20;
    return { ok: true, data: this.service.getRecentLiquidations(n) };
  }

  @Get('history')
  getHistory(@Query('limit') limit?: string) {
    const n = limit ? parseInt(limit, 10) : 50;
    return { ok: true, data: this.service.getHistory(n) };
  }

  @Get('status')
  getStatus() {
    return { ok: true, data: this.service.getStatus() };
  }

  @Get('health')
  health() {
    const status = this.service.getStatus();
    return {
      ok: true,
      data: {
        service: 'derivatives-feed',
        status: status.wsConnected ? 'healthy' : 'degraded',
        ...status,
      },
    };
  }
}
