import { Controller, Get, Inject, Query } from '@nestjs/common';
import { WhaleTrackerService } from './whale-tracker.service';

@Controller('api/v1/whales')
export class WhaleTrackerController {
  constructor(@Inject(WhaleTrackerService) private readonly whaleTrackerService: WhaleTrackerService) {}

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

  /** Live blockchain activity — 1h rolling window of mempool, fees, notable txs */
  @Get('blockchain')
  getBlockchainActivity() {
    return { ok: true, data: this.whaleTrackerService.getBlockchainActivity() };
  }

  /** LLM-ready text summary of blockchain activity */
  @Get('llm-summary')
  getLlmSummary() {
    return { ok: true, data: this.whaleTrackerService.getLlmSummary() };
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
        status: status.connected || status.mempoolConnected ? 'healthy' : 'degraded',
        ...status,
      },
    };
  }
}
