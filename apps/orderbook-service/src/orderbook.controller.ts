import { Controller, Get, Inject, Query } from '@nestjs/common';
import { OrderbookService } from './orderbook.service';

@Controller('api/v1/book')
export class OrderbookController {
  constructor(@Inject(OrderbookService) private readonly orderbookService: OrderbookService) {}

  /**
   * GET /api/v1/book/current
   * Returns the current normalized order book snapshot for both UP and DOWN tokens.
   */
  @Get('current')
  async getCurrentSnapshot() {
    const data = await this.orderbookService.getCurrentSnapshot();
    return { ok: true, data };
  }

  /**
   * GET /api/v1/book/depth?levels=10&side=up
   * Returns the top N levels for a given side.
   */
  @Get('depth')
  async getDepth(@Query('levels') levels?: string, @Query('side') side?: string) {
    const data = await this.orderbookService.getDepth({
      levels: levels ? parseInt(levels, 10) : 10,
      side: (side as 'up' | 'down') ?? 'up',
    });
    return { ok: true, data };
  }

  /**
   * GET /api/v1/book/metrics
   * Returns computed order book metrics (spread, imbalance, microprice, etc.).
   */
  @Get('metrics')
  async getMetrics() {
    const data = await this.orderbookService.getMetrics();
    return { ok: true, data };
  }

  /**
   * GET /api/v1/book/history?from=&to=
   * Returns historical book snapshots.
   */
  @Get('history')
  async getHistory(@Query('from') from: string, @Query('to') to: string) {
    const data = await this.orderbookService.getHistory({ from, to });
    return { ok: true, data };
  }
}
