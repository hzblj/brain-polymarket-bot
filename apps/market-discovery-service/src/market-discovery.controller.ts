import { Controller, Get, HttpCode, Inject, Post } from '@nestjs/common';
import { MarketDiscoveryService } from './market-discovery.service';

@Controller('api/v1/market')
export class MarketDiscoveryController {
  constructor(@Inject(MarketDiscoveryService) private readonly marketDiscoveryService: MarketDiscoveryService) {}

  /**
   * GET /api/v1/market/active
   * Returns the currently active "Bitcoin Up or Down - 5 Minutes" market.
   */
  @Get('active')
  async getActiveMarket() {
    const market = await this.marketDiscoveryService.getActiveMarket();
    return { ok: true, data: market };
  }

  /**
   * GET /api/v1/market/window/current
   * Returns the current 5-minute window timing information.
   */
  @Get('window/current')
  async getCurrentWindow() {
    const window = await this.marketDiscoveryService.getCurrentWindow();
    return { ok: true, data: window };
  }

  /**
   * GET /api/v1/market/tokens
   * Returns the UP/DOWN token IDs for the current active market.
   */
  @Get('tokens')
  getTokenIds() {
    const tokens = this.marketDiscoveryService.getTokenIds();
    return { ok: true, data: tokens };
  }

  /**
   * POST /api/v1/market/refresh
   * Manually triggers a market metadata refresh.
   */
  @Post('refresh')
  @HttpCode(200)
  async refreshMarket() {
    const result = await this.marketDiscoveryService.refreshMarket();
    return { ok: true, data: result };
  }
}
