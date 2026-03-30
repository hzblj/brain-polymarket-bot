import { Controller, Get, HttpCode, Inject, Post, Query } from '@nestjs/common';
import { FeatureEngineService } from './feature-engine.service';

@Controller('api/v1/features')
export class FeatureEngineController {
  constructor(@Inject(FeatureEngineService) private readonly featureEngineService: FeatureEngineService) {}

  /**
   * GET /api/v1/features/current
   * Returns the current unified feature payload combining market, price, book, and signals.
   */
  @Get('current')
  async getCurrentFeatures() {
    const data = await this.featureEngineService.getCurrentFeatures();
    return { ok: true, data };
  }

  /**
   * GET /api/v1/features/window/current
   * Returns features scoped to the current 5-minute window.
   */
  @Get('window/current')
  async getWindowFeatures() {
    const data = await this.featureEngineService.getWindowFeatures();
    return { ok: true, data };
  }

  /**
   * GET /api/v1/features/history?from=&to=
   * Returns historical feature snapshots.
   */
  @Get('history')
  async getHistory(@Query('from') from: string, @Query('to') to: string) {
    const data = await this.featureEngineService.getHistory({ from, to });
    return { ok: true, data };
  }

  /**
   * POST /api/v1/features/recompute
   * Manually triggers a feature recomputation.
   */
  @Post('recompute')
  @HttpCode(200)
  async recompute() {
    const data = await this.featureEngineService.recompute();
    return { ok: true, data };
  }
}
