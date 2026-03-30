import { Body, Controller, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { ReplayService } from './replay.service';
import type { ReplayRunRequest, ReplayWindowRequest } from './replay.service';

@Controller('api/v1/replay')
export class ReplayController {
  constructor(@Inject(ReplayService) private readonly replayService: ReplayService) {}

  /**
   * POST /api/v1/replay/run
   * Starts a replay over a specified time interval.
   * Loads historical data and re-evaluates all signals, risk, and agent proposals.
   */
  @Post('run')
  @HttpCode(201)
  async runReplay(@Body() body: ReplayRunRequest) {
    const result = await this.replayService.runReplay(body);
    return { ok: true, data: result };
  }

  /**
   * GET /api/v1/replay/:replayId
   * Returns the result of a specific replay run.
   */
  @Get(':replayId')
  async getReplay(@Param('replayId') replayId: string) {
    const result = await this.replayService.getReplay(replayId);
    return { ok: true, data: result };
  }

  /**
   * POST /api/v1/replay/window
   * Replays a single market window: loads its historical features and re-evaluates.
   */
  @Post('window')
  @HttpCode(200)
  async replayWindow(@Body() body: ReplayWindowRequest) {
    const result = await this.replayService.replayWindow(body);
    return { ok: true, data: result };
  }

  /**
   * GET /api/v1/replay/summary
   * Returns aggregated replay results across all replay runs.
   */
  @Get('summary')
  async getSummary() {
    const summary = await this.replayService.getSummary();
    return { ok: true, data: summary };
  }
}
