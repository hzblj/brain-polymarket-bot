import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { ExecutionService } from './execution.service';
import type { OrderInput } from './execution.service';

@Controller('api/v1/execution')
export class ExecutionController {
  constructor(@Inject(ExecutionService) private readonly executionService: ExecutionService) {}

  /**
   * GET /api/v1/execution/health
   * Returns health status of the execution service.
   */
  @Get('health')
  getHealth() {
    return {
      ok: true,
      service: 'execution',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * POST /api/v1/execution/paper-order
   * Places a paper (simulated) trade using current orderbook data.
   */
  @Post('paper-order')
  @HttpCode(201)
  async paperOrder(@Body() body: OrderInput) {
    const order = await this.executionService.paperOrder(body);
    return { ok: true, data: order };
  }

  /**
   * POST /api/v1/execution/live-order
   * Places a live order on Polymarket via @brain/polymarket-client.
   */
  @Post('live-order')
  @HttpCode(201)
  async liveOrder(@Body() body: OrderInput) {
    const order = await this.executionService.liveOrder(body);
    return { ok: true, data: order };
  }

  /**
   * GET /api/v1/execution/orders/:orderId
   * Returns the current status and details of a specific order.
   */
  @Get('orders/:orderId')
  async getOrder(@Param('orderId') orderId: string) {
    const order = await this.executionService.getOrder(orderId);
    return { ok: true, data: order };
  }

  /**
   * POST /api/v1/execution/orders/:orderId/cancel
   * Attempts to cancel an open order.
   */
  @Post('orders/:orderId/cancel')
  @HttpCode(200)
  async cancelOrder(@Param('orderId') orderId: string) {
    const result = await this.executionService.cancelOrder(orderId);
    return { ok: true, data: result };
  }

  /**
   * GET /api/v1/execution/fills
   * Returns recent fills, optionally filtered by windowId.
   */
  @Get('fills')
  async getFills(@Query('windowId') windowId?: string, @Query('limit') limit?: string) {
    const fills = await this.executionService.getFills(
      windowId,
      limit ? parseInt(limit, 10) : undefined,
    );
    return { ok: true, data: fills };
  }

  /**
   * GET /api/v1/execution/positions
   * Returns current open exposure / positions.
   */
  @Get('positions')
  async getPositions() {
    const positions = await this.executionService.getPositions();
    return { ok: true, data: positions };
  }

  /**
   * GET /api/v1/execution/resolved
   * Returns resolved (closed) orders with P&L.
   */
  @Get('resolved')
  getResolved(@Query('limit') limit?: string) {
    const n = limit ? parseInt(limit, 10) : 50;
    const resolved = this.executionService.getResolvedOrders(n);
    return { ok: true, data: resolved };
  }
}
