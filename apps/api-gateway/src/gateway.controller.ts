import { All, Controller, Get, Inject, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { GatewayService } from './gateway.service';

@Controller()
export class GatewayController {
  constructor(@Inject(GatewayService) private readonly gatewayService: GatewayService) {}

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
   * GET /api/v1/strategies
   * Returns available trading strategies.
   */
  @Get('api/v1/strategies')
  getStrategies() {
    return {
      ok: true,
      data: [
        {
          id: 'btc_5m_momentum_v1',
          key: 'btc_5m_momentum',
          name: 'BTC 5-Minute Momentum',
          description: 'Trades Polymarket BTC 5-minute Up/Down binary markets using regime classification, edge detection, and risk-adjusted sizing.',
          status: 'active',
          isDefault: true,
          latestVersion: 1,
          createdAt: '2026-03-20T00:00:00Z',
          updatedAt: new Date().toISOString(),
        },
      ],
    };
  }

  /**
   * GET /api/v1/strategies/:id
   */
  @Get('api/v1/strategies/:id')
  getStrategy() {
    return {
      ok: true,
      data: {
        id: 'btc_5m_momentum_v1',
        key: 'btc_5m_momentum',
        name: 'BTC 5-Minute Momentum',
        version: 1,
        agents: ['regime', 'edge', 'supervisor'],
        riskProfile: { maxSizeUsd: 50, maxSpreadBps: 300, minDepthScore: 0.1 },
      },
    };
  }

  /**
   * Proxy: /api/v1/market/* -> market-discovery-service (port 3001)
   */
  @All('api/v1/market/*')
  proxyMarket(@Req() req: FastifyRequest, @Res() res: FastifyReply) {
    return this.gatewayService.proxy(req, res, 'market-discovery', 3001);
  }

  /**
   * Proxy: /api/v1/price/* -> price-feed-service (port 3002)
   */
  @All('api/v1/price/*')
  proxyPrices(@Req() req: FastifyRequest, @Res() res: FastifyReply) {
    return this.gatewayService.proxy(req, res, 'price-feed', 3002);
  }

  /**
   * Proxy: /api/v1/book/* -> orderbook-service (port 3003)
   */
  @All('api/v1/book/*')
  proxyOrderbook(@Req() req: FastifyRequest, @Res() res: FastifyReply) {
    return this.gatewayService.proxy(req, res, 'orderbook', 3003);
  }

  /**
   * Proxy: /api/v1/features/* -> feature-engine-service (port 3004)
   */
  @All('api/v1/features/*')
  proxyFeatures(@Req() req: FastifyRequest, @Res() res: FastifyReply) {
    return this.gatewayService.proxy(req, res, 'feature-engine', 3004);
  }

  /**
   * Proxy: /api/v1/risk/* -> risk-service (port 3005)
   */
  @All('api/v1/risk/*')
  proxyRisk(@Req() req: FastifyRequest, @Res() res: FastifyReply) {
    return this.gatewayService.proxy(req, res, 'risk', 3005);
  }

  /**
   * Proxy: /api/v1/execution/* -> execution-service (port 3006)
   */
  @All('api/v1/execution/*')
  proxyExecution(@Req() req: FastifyRequest, @Res() res: FastifyReply) {
    return this.gatewayService.proxy(req, res, 'execution', 3006);
  }

  /**
   * Proxy: /api/v1/config -> config-service (port 3007)
   */
  @All('api/v1/config')
  proxyConfigRoot(@Req() req: FastifyRequest, @Res() res: FastifyReply) {
    return this.gatewayService.proxy(req, res, 'config', 3007);
  }

  /**
   * Proxy: /api/v1/config/* -> config-service (port 3007)
   */
  @All('api/v1/config/*')
  proxyConfig(@Req() req: FastifyRequest, @Res() res: FastifyReply) {
    return this.gatewayService.proxy(req, res, 'config', 3007);
  }

  /**
   * Proxy: /api/v1/agent/* -> agent-gateway-service (port 3008)
   */
  @All('api/v1/agent/*')
  proxyAgent(@Req() req: FastifyRequest, @Res() res: FastifyReply) {
    return this.gatewayService.proxy(req, res, 'agent-gateway', 3008);
  }

  /**
   * Proxy: /api/v1/replay/* -> replay-service (port 3009)
   */
  @All('api/v1/replay/*')
  proxyReplay(@Req() req: FastifyRequest, @Res() res: FastifyReply) {
    return this.gatewayService.proxy(req, res, 'replay', 3009);
  }
}
