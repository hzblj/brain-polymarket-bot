import type { MessageEvent } from '@nestjs/common';
import { Controller, Get, Inject, Query, Sse } from '@nestjs/common';
import { from, interval, map, Observable, switchMap } from 'rxjs';
import { DashboardService } from './dashboard.service';

@Controller('api/v1/dashboard')
export class DashboardController {
  constructor(@Inject(DashboardService) private readonly dashboardService: DashboardService) {}

  @Get('state')
  async getState() {
    const data = await this.dashboardService.getSystemState();
    return { ok: true, data };
  }

  @Get('snapshot')
  async getSnapshot() {
    const data = await this.dashboardService.getMarketSnapshot();
    return { ok: true, data };
  }

  @Get('pipeline')
  async getPipeline() {
    const data = await this.dashboardService.getPipeline();
    return { ok: true, data };
  }

  @Get('trades/open')
  async getOpenTrades() {
    const data = await this.dashboardService.getOpenTrades();
    return { ok: true, data };
  }

  @Get('trades/closed')
  async getClosedTrades() {
    const data = await this.dashboardService.getClosedTrades();
    return { ok: true, data };
  }

  @Get('metrics')
  async getMetrics() {
    const data = await this.dashboardService.getTodayMetrics();
    return { ok: true, data };
  }

  @Get('simulation')
  async getSimulation() {
    const data = await this.dashboardService.getSimulationSummary();
    return { ok: true, data };
  }

  @Get('prices')
  async getPrices(@Query('range') range?: string) {
    const data = await this.dashboardService.getPriceHistory(range ?? '5m');
    return { ok: true, data };
  }

  @Get('book')
  async getBook(@Query('range') range?: string) {
    const data = await this.dashboardService.getBookHistory(range ?? '5m');
    return { ok: true, data };
  }

  @Get('timing')
  async getTiming() {
    const data = await this.dashboardService.getPipelineTiming();
    return { ok: true, data };
  }

  @Get('health')
  async getHealth() {
    const data = await this.dashboardService.getServiceHealth();
    return { ok: true, data };
  }

  @Get('feeds')
  async getFeeds() {
    const data = await this.dashboardService.getFeedStatus();
    return { ok: true, data };
  }

  @Get('events')
  async getEvents() {
    const data = await this.dashboardService.getEvents();
    return { ok: true, data };
  }

  @Get('llm-costs')
  async getLlmCosts() {
    const data = await this.dashboardService.getLlmCosts();
    return { ok: true, data };
  }

  @Sse('stream')
  stream(): Observable<MessageEvent> {
    return interval(2000).pipe(
      switchMap(() => from(this.dashboardService.getStreamUpdate())),
      map((data) => ({ data }) as MessageEvent),
    );
  }
}
