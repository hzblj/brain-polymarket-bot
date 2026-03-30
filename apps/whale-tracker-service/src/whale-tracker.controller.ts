import { Controller, Get, Query } from '@nestjs/common';
import { WhaleTrackerService } from './whale-tracker.service';

@Controller('api/v1/whales')
export class WhaleTrackerController {
  constructor(private readonly whaleTrackerService: WhaleTrackerService) {}

  @Get('current')
  getCurrentFeatures() {
    return { ok: true, data: this.whaleTrackerService.getCurrentFeatures() };
  }

  @Get('transactions')
  getRecentTransactions(@Query('limit') limit?: string) {
    const n = limit ? parseInt(limit, 10) : 20;
    return { ok: true, data: this.whaleTrackerService.getRecentTransactions(n) };
  }

  @Get('history')
  getHistory(@Query('limit') limit?: string) {
    const n = limit ? parseInt(limit, 10) : 50;
    return { ok: true, data: this.whaleTrackerService.getHistory(n) };
  }

  @Get('status')
  getStatus() {
    return { ok: true, data: this.whaleTrackerService.getStatus() };
  }

  @Get('health')
  health() {
    const status = this.whaleTrackerService.getStatus();
    return {
      ok: true,
      data: {
        service: 'whale-tracker',
        status: status.connected ? 'healthy' : 'degraded',
        ...status,
      },
    };
  }
}
