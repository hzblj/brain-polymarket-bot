import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import {
  AgentGatewayService,
  type EdgeEvaluationRequest,
  type RegimeEvaluationRequest,
  type SupervisorEvaluationRequest,
} from './agent-gateway.service';

@Controller('api/v1/agent')
export class AgentGatewayController {
  constructor(@Inject(AgentGatewayService) private readonly agentGatewayService: AgentGatewayService) {}

  /**
   * GET /api/v1/agent/health
   * Returns health status of the agent-gateway service.
   */
  @Get('health')
  getHealth() {
    return {
      ok: true,
      service: 'agent-gateway',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    };
  }

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
   * GET /api/v1/agent/context
   * Returns combined structured context for agents (features + risk + config).
   */
  @Get('context')
  async getContext() {
    const context = await this.agentGatewayService.getContext();
    return { ok: true, data: context };
  }

  /**
   * POST /api/v1/agent/decision/validate
   * Validates and normalizes an agent decision payload.
   */
  @Post('decision/validate')
  @HttpCode(200)
  async validateDecision(@Body() body: Record<string, unknown>) {
    const result = await this.agentGatewayService.validateDecision(body);
    return { ok: true, data: result };
  }

  /**
   * POST /api/v1/agent/decision/log
   * Persists a decision trace for auditing.
   */
  @Post('decision/log')
  @HttpCode(200)
  async logDecision(@Body() body: Record<string, unknown>) {
    const result = await this.agentGatewayService.logDecision(body);
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
   * GET /api/v1/agent/traces/:traceId
   * Returns full detail of a specific LLM decision trace.
   */
  @Get('traces/:traceId')
  async getTrace(@Param('traceId') traceId: string) {
    const trace = await this.agentGatewayService.getTrace(traceId);
    return { ok: true, data: trace };
  }
}
