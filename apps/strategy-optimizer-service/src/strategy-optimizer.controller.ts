import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { StrategyOptimizerService } from './strategy-optimizer.service';
import type { GenerateReportRequest } from './strategy-optimizer.service';

@Controller('api/v1/optimizer')
export class StrategyOptimizerController {
  constructor(
    @Inject(StrategyOptimizerService)
    private readonly optimizerService: StrategyOptimizerService,
  ) {}

  @Post('generate-report')
  @HttpCode(200)
  async generateReport(@Body() body: GenerateReportRequest) {
    const report = await this.optimizerService.generateReport(body);
    return { ok: true, data: report };
  }

  @Get('reports')
  async listReports(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
  ) {
    const reports = await this.optimizerService.listReports({
      from,
      to,
      limit: limit ? parseInt(limit, 10) : 30,
    });
    return { ok: true, data: reports };
  }

  @Get('reports/:id')
  async getReport(@Param('id') id: string) {
    const report = await this.optimizerService.getReport(id);
    return { ok: true, data: report };
  }

  @Get('status')
  async getStatus() {
    const status = this.optimizerService.getSchedulerStatus();
    return { ok: true, data: status };
  }

  @Post('enable')
  @HttpCode(200)
  async enable() {
    this.optimizerService.setSchedulerEnabled(true);
    return { ok: true, data: { enabled: true } };
  }

  @Post('disable')
  @HttpCode(200)
  async disable() {
    this.optimizerService.setSchedulerEnabled(false);
    return { ok: true, data: { enabled: false } };
  }
}
