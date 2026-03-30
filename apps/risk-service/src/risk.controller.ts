import { Body, Controller, Get, HttpCode, Inject, Post } from '@nestjs/common';
import { RiskService } from './risk.service';
import type { RiskConfigUpdate, RiskEvaluationRequest } from './risk.service';

@Controller('api/v1/risk')
export class RiskController {
  constructor(@Inject(RiskService) private readonly riskService: RiskService) {}

  /**
   * GET /api/v1/risk/state
   * Returns the current risk state including daily P&L, open exposure, and config.
   */
  @Get('state')
  async getState() {
    const state = await this.riskService.getState();
    return { ok: true, data: state };
  }

  /**
   * POST /api/v1/risk/evaluate
   * Evaluates a proposed trade against all risk guardrails.
   * Returns approval status, approved size, and any rejection reasons.
   */
  @Post('evaluate')
  @HttpCode(200)
  async evaluate(@Body() body: RiskEvaluationRequest) {
    const evaluation = await this.riskService.evaluate(body);
    return { ok: true, data: evaluation };
  }

  /**
   * POST /api/v1/risk/kill-switch/on
   * Activates the kill switch. All subsequent trade evaluations will be rejected.
   */
  @Post('kill-switch/on')
  @HttpCode(200)
  async killSwitchOn() {
    const result = await this.riskService.setKillSwitch(true);
    return { ok: true, data: result };
  }

  /**
   * POST /api/v1/risk/kill-switch/off
   * Deactivates the kill switch. Trade evaluations resume normal processing.
   */
  @Post('kill-switch/off')
  @HttpCode(200)
  async killSwitchOff() {
    const result = await this.riskService.setKillSwitch(false);
    return { ok: true, data: result };
  }

  /**
   * POST /api/v1/risk/config
   * Updates risk configuration limits (max size, daily loss limit, etc.).
   */
  @Post('config')
  @HttpCode(200)
  async updateConfig(@Body() body: RiskConfigUpdate) {
    const result = await this.riskService.updateConfig(body);
    return { ok: true, data: result };
  }
}
