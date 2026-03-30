import { Controller, Get, HttpCode, Inject, Post, Query } from '@nestjs/common';
import { PriceFeedService } from './price-feed.service';

@Controller('api/v1/price')
export class PriceFeedController {
  constructor(@Inject(PriceFeedService) private readonly priceFeedService: PriceFeedService) {}

  /**
   * GET /api/v1/price/current
   * Returns the last known prices from resolver and external sources,
   * plus window delta and micro-structure signals.
   */
  @Get('current')
  async getCurrentPrice() {
    const data = await this.priceFeedService.getCurrentPrice();
    return { ok: true, data };
  }

  /**
   * GET /api/v1/price/window/current
   * Returns price data scoped to the current 5-minute window.
   */
  @Get('window/current')
  async getWindowData() {
    const data = await this.priceFeedService.getWindowData();
    return { ok: true, data };
  }

  /**
   * GET /api/v1/price/history?from=&to=&source=&interval=
   * Returns historical price ticks within a time range.
   */
  @Get('history')
  async getHistory(
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('source') source?: string,
    @Query('interval') interval?: string,
  ) {
    const data = await this.priceFeedService.getHistory({
      from,
      to,
      source: source ?? 'all',
      interval: interval ?? '1s',
    });
    return { ok: true, data };
  }

  /**
   * POST /api/v1/price/window/reset
   * Saves a new start price when a fresh 5-minute window opens.
   */
  @Post('window/reset')
  @HttpCode(200)
  async resetWindow() {
    const data = await this.priceFeedService.resetWindow();
    return { ok: true, data };
  }
}
