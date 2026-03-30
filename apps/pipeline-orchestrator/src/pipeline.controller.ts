import { Body, Controller, Get, HttpCode, Inject, Post } from '@nestjs/common';
import { PipelineService } from './pipeline.service';

@Controller('api/v1/pipeline')
export class PipelineController {
  constructor(@Inject(PipelineService) private readonly pipelineService: PipelineService) {}

  /**
   * GET /api/v1/pipeline/health
   * Returns health status of the pipeline-orchestrator service.
   */
  @Get('health')
  getHealth() {
    return {
      ok: true,
      service: 'pipeline-orchestrator',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * GET /api/v1/pipeline/status
   * Returns current pipeline status, cycle count, and last result.
   */
  @Get('status')
  getStatus() {
    return { ok: true, data: this.pipelineService.getStatus() };
  }

  /**
   * POST /api/v1/pipeline/trigger
   * Manually triggers a single pipeline cycle.
   */
  @Post('trigger')
  @HttpCode(200)
  async trigger() {
    const result = await this.pipelineService.triggerOnce();
    return { ok: true, data: result };
  }

  /**
   * POST /api/v1/pipeline/enable
   * Enables or disables the automatic pipeline loop.
   */
  @Post('enable')
  @HttpCode(200)
  enable(@Body() body: { enabled: boolean }) {
    this.pipelineService.setEnabled(body.enabled);
    return { ok: true, data: { enabled: body.enabled } };
  }
}
