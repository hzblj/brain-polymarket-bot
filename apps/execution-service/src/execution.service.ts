import { Injectable, OnModuleInit, HttpException, HttpStatus } from '@nestjs/common';
import type {
  Order,
  Fill,
  OrderStatus,
  OrderSide,
  ExecutionMode,
  UnixMs,
} from '@brain/types';

// ─── Input / Output Types ────────────────────────────────────────────────────

export interface OrderInput {
  marketId: string;
  side: 'UP' | 'DOWN';
  mode: 'paper' | 'live';
  sizeUsd: number;
  maxEntryPrice: number;
  mustExecuteBeforeSec: number;
  source: string;
  windowId?: string;
  riskDecisionId?: string;
}

interface InternalOrder {
  id: string;
  marketId: string;
  windowId: string;
  riskDecisionId: string;
  side: OrderSide;
  mode: ExecutionMode;
  sizeUsd: number;
  entryPrice: number;
  maxEntryPrice: number;
  status: OrderStatus;
  polymarketOrderId: string | null;
  source: string;
  mustExecuteBeforeMs: UnixMs;
  createdAt: string;
  updatedAt: string;
  fills: InternalFill[];
  filledSizeUsd: number;
}

interface InternalFill {
  id: string;
  orderId: string;
  fillPrice: number;
  fillSizeUsd: number;
  filledAt: string;
}

interface Position {
  marketId: string;
  side: OrderSide;
  sizeUsd: number;
  avgEntryPrice: number;
  mode: ExecutionMode;
  openedAt: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const DATA_FRESHNESS_THRESHOLD_MS = 10_000;

@Injectable()
export class ExecutionService implements OnModuleInit {
  private orders: Map<string, InternalOrder> = new Map();
  private positions: Map<string, Position> = new Map();

  // TODO: inject @brain/polymarket-client, @brain/database, @brain/events, @brain/logger
  // constructor(
  //   private readonly polymarketClient: PolymarketClient,
  //   private readonly database: DatabaseService,
  //   private readonly events: EventsService,
  //   private readonly logger: LoggerService,
  // ) {}

  async onModuleInit(): Promise<void> {
    // Load open orders and positions from database
    await this.loadOpenOrders();
    console.log('[execution-service] initialized');
  }

  // ─── Public API ──────────────────────────────────────────────────────────────

  /**
   * Executes a paper (simulated) trade.
   * Simulates fill using the current orderbook mid price.
   */
  async paperOrder(input: OrderInput): Promise<InternalOrder> {
    this.validateFreshness(input.mustExecuteBeforeSec);

    const order = this.createOrder(input, 'paper');

    // Simulate immediate fill at maxEntryPrice (paper mode uses mid price simulation)
    const simulatedFillPrice = input.maxEntryPrice;
    const fill = this.createFill(order.id, simulatedFillPrice, input.sizeUsd);

    order.fills.push(fill);
    order.filledSizeUsd = input.sizeUsd;
    order.entryPrice = simulatedFillPrice;
    order.status = 'filled';
    order.updatedAt = new Date().toISOString();

    this.orders.set(order.id, order);

    // Update position tracking
    this.updatePosition(order);

    // Persist to database
    // await this.database.orders.insert(order);
    // await this.database.fills.insert(fill);

    this.emitEvent('order.created', { orderId: order.id, mode: 'paper', side: order.side });
    this.emitEvent('order.filled', {
      orderId: order.id,
      mode: 'paper',
      fillPrice: simulatedFillPrice,
      fillSizeUsd: input.sizeUsd,
    });

    console.log(`[execution-service] Paper order filled: ${order.id} ${order.side} $${input.sizeUsd} @ ${simulatedFillPrice}`);
    return order;
  }

  /**
   * Executes a live trade via Polymarket.
   * Calls @brain/polymarket-client to place the actual order.
   */
  async liveOrder(input: OrderInput): Promise<InternalOrder> {
    this.validateFreshness(input.mustExecuteBeforeSec);

    const order = this.createOrder(input, 'live');
    this.orders.set(order.id, order);

    this.emitEvent('order.created', { orderId: order.id, mode: 'live', side: order.side });

    try {
      // TODO: Call polymarket-client to place the order
      // const polyOrder = await this.polymarketClient.placeOrder({
      //   tokenId: input.side === 'UP' ? market.upTokenId : market.downTokenId,
      //   side: 'buy',
      //   price: input.maxEntryPrice,
      //   size: input.sizeUsd / input.maxEntryPrice,
      // });
      // order.polymarketOrderId = polyOrder.id;

      // Stub: simulate placing an order that transitions to OPEN
      order.polymarketOrderId = `poly-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      order.status = 'placed';
      order.updatedAt = new Date().toISOString();

      // Persist to database
      // await this.database.orders.insert(order);

      console.log(`[execution-service] Live order placed: ${order.id} → polymarket: ${order.polymarketOrderId}`);

      // In production, order fills would come via WebSocket subscription
      // For now, simulate a fill after placement
      await this.simulateLiveFill(order);

      return order;
    } catch (error) {
      order.status = 'failed';
      order.updatedAt = new Date().toISOString();
      // await this.database.orders.update(order.id, { status: 'failed' });

      console.error(`[execution-service] Live order failed: ${order.id}`, error);
      throw new HttpException(
        `Order placement failed: ${(error as Error).message}`,
        HttpStatus.BAD_GATEWAY,
      );
    }
  }

  /**
   * Retrieves a single order by ID.
   */
  async getOrder(orderId: string): Promise<InternalOrder> {
    const order = this.orders.get(orderId);
    if (!order) {
      // TODO: Fall back to database lookup
      // const dbOrder = await this.database.orders.findById(orderId);
      throw new HttpException(`Order ${orderId} not found`, HttpStatus.NOT_FOUND);
    }
    return order;
  }

  /**
   * Attempts to cancel an open order.
   */
  async cancelOrder(orderId: string): Promise<InternalOrder> {
    const order = await this.getOrder(orderId);

    if (order.status === 'filled' || order.status === 'cancelled' || order.status === 'failed') {
      throw new HttpException(
        `Cannot cancel order in status '${order.status}'`,
        HttpStatus.BAD_REQUEST,
      );
    }

    if (order.mode === 'live' && order.polymarketOrderId) {
      // TODO: Call polymarket-client to cancel
      // await this.polymarketClient.cancelOrder(order.polymarketOrderId);
      console.log(`[execution-service] Cancelling live order: ${order.polymarketOrderId}`);
    }

    order.status = 'cancelled';
    order.updatedAt = new Date().toISOString();
    // await this.database.orders.update(orderId, { status: 'cancelled' });

    this.emitEvent('order.cancelled', { orderId: order.id, mode: order.mode });
    console.log(`[execution-service] Order cancelled: ${orderId}`);

    return order;
  }

  /**
   * Returns fills, optionally filtered by windowId.
   */
  async getFills(windowId?: string, limit = 50): Promise<InternalFill[]> {
    // TODO: Load from database
    // return this.database.fills.find({ windowId, limit });

    const allFills: InternalFill[] = [];
    for (const order of this.orders.values()) {
      if (windowId && order.windowId !== windowId) continue;
      allFills.push(...order.fills);
    }

    return allFills
      .sort((a, b) => new Date(b.filledAt).getTime() - new Date(a.filledAt).getTime())
      .slice(0, limit);
  }

  /**
   * Returns all current open positions.
   */
  async getPositions(): Promise<Position[]> {
    // TODO: Load from database
    // return this.database.positions.findOpen();
    return Array.from(this.positions.values());
  }

  // ─── Internal Helpers ──────────────────────────────────────────────────────

  private validateFreshness(mustExecuteBeforeSec: number): void {
    // The caller tells us how many seconds remain; reject if it is already expired
    if (mustExecuteBeforeSec <= 0) {
      throw new HttpException(
        'Execution deadline has already passed',
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  private createOrder(input: OrderInput, mode: ExecutionMode): InternalOrder {
    const now = new Date();
    const side: OrderSide = input.side === 'UP' ? 'buy_up' : 'buy_down';

    return {
      id: `ord-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      marketId: input.marketId,
      windowId: input.windowId ?? '',
      riskDecisionId: input.riskDecisionId ?? '',
      side,
      mode,
      sizeUsd: input.sizeUsd,
      entryPrice: 0,
      maxEntryPrice: input.maxEntryPrice,
      status: 'pending',
      polymarketOrderId: null,
      source: input.source,
      mustExecuteBeforeMs: now.getTime() + input.mustExecuteBeforeSec * 1000,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      fills: [],
      filledSizeUsd: 0,
    };
  }

  private createFill(orderId: string, price: number, sizeUsd: number): InternalFill {
    return {
      id: `fill-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      orderId,
      fillPrice: price,
      fillSizeUsd: sizeUsd,
      filledAt: new Date().toISOString(),
    };
  }

  private updatePosition(order: InternalOrder): void {
    const key = `${order.marketId}:${order.side}`;
    const existing = this.positions.get(key);

    if (existing) {
      const totalSize = existing.sizeUsd + order.filledSizeUsd;
      existing.avgEntryPrice =
        (existing.avgEntryPrice * existing.sizeUsd + order.entryPrice * order.filledSizeUsd) /
        totalSize;
      existing.sizeUsd = totalSize;
    } else {
      this.positions.set(key, {
        marketId: order.marketId,
        side: order.side,
        sizeUsd: order.filledSizeUsd,
        avgEntryPrice: order.entryPrice,
        mode: order.mode,
        openedAt: order.createdAt,
      });
    }
  }

  private async simulateLiveFill(order: InternalOrder): Promise<void> {
    // In production this would come from a WebSocket fill event.
    // For now, simulate an immediate fill at maxEntryPrice.
    const fill = this.createFill(order.id, order.maxEntryPrice, order.sizeUsd);
    order.fills.push(fill);
    order.filledSizeUsd = order.sizeUsd;
    order.entryPrice = order.maxEntryPrice;
    order.status = 'filled';
    order.updatedAt = new Date().toISOString();

    this.updatePosition(order);

    // await this.database.fills.insert(fill);
    // await this.database.orders.update(order.id, { status: 'filled', entryPrice: order.entryPrice });

    this.emitEvent('order.filled', {
      orderId: order.id,
      mode: order.mode,
      fillPrice: fill.fillPrice,
      fillSizeUsd: fill.fillSizeUsd,
    });
  }

  private async loadOpenOrders(): Promise<void> {
    // TODO: Load open orders from database on startup
    // const open = await this.database.orders.findByStatus(['pending', 'placed', 'partial']);
    // for (const order of open) this.orders.set(order.id, order);
  }

  private emitEvent(event: string, payload: Record<string, unknown>): void {
    // TODO: Wire to @brain/events
    // this.events.emit(event, payload);
    console.log(`[execution-service] event: ${event}`, JSON.stringify(payload));
  }
}
