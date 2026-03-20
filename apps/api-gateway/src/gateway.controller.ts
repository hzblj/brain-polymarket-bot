import { Controller, All, Get, Req, Res, HttpCode } from '@nestjs/common';
import { FastifyRequest, FastifyReply } from 'fastify';
import { GatewayService } from './gateway.service';

@Controller()
export class GatewayController {
  constructor(private readonly gatewayService: GatewayService) {}

  /**
   * GET /health
   * Returns health status of the api-gateway and aggregated health of all downstream services.
   */
  @Get('health')
  async healthCheck() {
    const health = await this.gatewayService.aggregateHealthChecks();
    return { ok: true, data: health };
  }

  /**
   * GET /api/v1/status
   * Returns aggregated system status: mode, active market, positions, daily P&L.
   */
  @Get('api/v1/status')
  async systemStatus() {
    const status = await this.gatewayService.getSystemStatus();
    return { ok: true, data: status };
  }

  /**
   * Proxy: /api/v1/market/* -> market-discovery-service (port 3001)
   */
  @All('api/v1/market/*')
  async proxyMarket(@Req() req: FastifyRequest, @Res() res: FastifyReply) {
    return this.gatewayService.proxy(req, res, 'market-discovery', 3001);
  }

  /**
   * Proxy: /api/v1/prices/* -> price-feed-service (port 3002)
   */
  @All('api/v1/prices/*')
  async proxyPrices(@Req() req: FastifyRequest, @Res() res: FastifyReply) {
    return this.gatewayService.proxy(req, res, 'price-feed', 3002);
  }

  /**
   * Proxy: /api/v1/orderbook/* -> orderbook-service (port 3003)
   */
  @All('api/v1/orderbook/*')
  async proxyOrderbook(@Req() req: FastifyRequest, @Res() res: FastifyReply) {
    return this.gatewayService.proxy(req, res, 'orderbook', 3003);
  }

  /**
   * Proxy: /api/v1/features/* -> feature-engine-service (port 3004)
   */
  @All('api/v1/features/*')
  async proxyFeatures(@Req() req: FastifyRequest, @Res() res: FastifyReply) {
    return this.gatewayService.proxy(req, res, 'feature-engine', 3004);
  }

  /**
   * Proxy: /api/v1/risk/* -> risk-service (port 3005)
   */
  @All('api/v1/risk/*')
  async proxyRisk(@Req() req: FastifyRequest, @Res() res: FastifyReply) {
    return this.gatewayService.proxy(req, res, 'risk', 3005);
  }

  /**
   * Proxy: /api/v1/execution/* -> execution-service (port 3006)
   */
  @All('api/v1/execution/*')
  async proxyExecution(@Req() req: FastifyRequest, @Res() res: FastifyReply) {
    return this.gatewayService.proxy(req, res, 'execution', 3006);
  }

  /**
   * Proxy: /api/v1/config/* -> config-service (port 3007)
   */
  @All('api/v1/config/*')
  async proxyConfig(@Req() req: FastifyRequest, @Res() res: FastifyReply) {
    return this.gatewayService.proxy(req, res, 'config', 3007);
  }

  /**
   * Proxy: /api/v1/agent/* -> agent-gateway-service (port 3008)
   */
  @All('api/v1/agent/*')
  async proxyAgent(@Req() req: FastifyRequest, @Res() res: FastifyReply) {
    return this.gatewayService.proxy(req, res, 'agent-gateway', 3008);
  }

  /**
   * Proxy: /api/v1/replay/* -> replay-service (port 3009)
   */
  @All('api/v1/replay/*')
  async proxyReplay(@Req() req: FastifyRequest, @Res() res: FastifyReply) {
    return this.gatewayService.proxy(req, res, 'replay', 3009);
  }
}
