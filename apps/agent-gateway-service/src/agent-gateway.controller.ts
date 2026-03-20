import { Controller, Get, Post, Body, Param, Query, HttpCode } from '@nestjs/common';
import { AgentGatewayService } from './agent-gateway.service';
import type {
  RegimeEvaluationRequest,
  EdgeEvaluationRequest,
  SupervisorEvaluationRequest,
} from './agent-gateway.service';

@Controller('api/v1/agent')
export class AgentGatewayController {
  constructor(private readonly agentGatewayService: AgentGatewayService) {}

  /**
   * POST /api/v1/agent/regime/evaluate
   * Classifies the current market regime using an LLM agent.
   * Input: feature payload. Output: regime classification with confidence.
   */
  @Post('regime/evaluate')
  @HttpCode(200)
  async evaluateRegime(@Body() body: RegimeEvaluationRequest) {
    const result = await this.agentGatewayService.evaluateRegime(body);
    return { ok: true, data: result };
  }

  /**
   * POST /api/v1/agent/edge/evaluate
   * Estimates fair probability and edge for UP/DOWN outcomes using an LLM agent.
   * Input: feature payload. Output: edge assessment with direction and magnitude.
   */
  @Post('edge/evaluate')
  @HttpCode(200)
  async evaluateEdge(@Body() body: EdgeEvaluationRequest) {
    const result = await this.agentGatewayService.evaluateEdge(body);
    return { ok: true, data: result };
  }

  /**
   * POST /api/v1/agent/supervisor/evaluate
   * Synthesizes all signals into a single trade decision using an LLM agent.
   * Input: features + risk snapshot. Output: trade proposal (buy_up/buy_down/hold).
   */
  @Post('supervisor/evaluate')
  @HttpCode(200)
  async evaluateSupervisor(@Body() body: SupervisorEvaluationRequest) {
    const result = await this.agentGatewayService.evaluateSupervisor(body);
    return { ok: true, data: result };
  }

  /**
   * GET /api/v1/agent/traces
   * Returns recent LLM agent decision traces for auditing.
   */
  @Get('traces')
  async listTraces(
    @Query('agentType') agentType?: string,
    @Query('windowId') windowId?: string,
    @Query('limit') limit?: string,
  ) {
    const traces = await this.agentGatewayService.listTraces(
      agentType,
      windowId,
      limit ? parseInt(limit, 10) : undefined,
    );
    return { ok: true, data: traces };
  }

  /**
   * GET /api/v1/agent/trace/:traceId
   * Returns full detail of a specific LLM decision trace.
   */
  @Get('trace/:traceId')
  async getTrace(@Param('traceId') traceId: string) {
    const trace = await this.agentGatewayService.getTrace(traceId);
    return { ok: true, data: trace };
  }
}
