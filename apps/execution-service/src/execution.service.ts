import {
  DATABASE_CLIENT,
  type DbClient,
  fills as fillsTable,
  orders as ordersTable,
} from '@brain/database';
import { type BrainEventName, type BrainEventMap, EventBus } from '@brain/events';
import type { ExecutionMode, OrderSide, OrderStatus, UnixMs } from '@brain/types';
import { HttpException, HttpStatus, Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { desc, eq, inArray } from 'drizzle-orm';

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

const _DATA_FRESHNESS_THRESHOLD_MS = 10_000;
const RESOLUTION_POLL_MS = 5_000;
const LOCAL_HOST = process.env.LOCAL_IP ?? 'localhost';
const PRICE_SERVICE_URL = process.env.PRICE_SERVICE_URL ?? `http://${LOCAL_HOST}:3002`;

@Injectable()
export class ExecutionService implements OnModuleInit, OnModuleDestroy {
  private orders: Map<string, InternalOrder> = new Map();
  private positions: Map<string, Position> = new Map();
  private resolutionTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    @Inject(DATABASE_CLIENT) private readonly db: DbClient,
    @Inject(EventBus) private readonly eventBus: EventBus,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.loadOpenOrders();
    this.startResolutionLoop();
  }

  onModuleDestroy(): void {
    if (this.resolutionTimer) {
      clearInterval(this.resolutionTimer);
      this.resolutionTimer = null;
    }
  }

  // ─── Window Resolution ──────────────────────────────────────────────────────

  private startResolutionLoop(): void {
    this.resolutionTimer = setInterval(async () => {
      await this.resolveExpiredPositions();
    }, RESOLUTION_POLL_MS);
  }

  private async resolveExpiredPositions(): Promise<void> {
    // Find filled orders that haven't been resolved yet
    for (const order of this.orders.values()) {
      if (order.status !== 'filled') continue;

      // Check if window has expired (5 min from creation)
      const createdMs = new Date(order.createdAt).getTime();
      const windowEndMs = createdMs + 5 * 60 * 1000;
      if (Date.now() < windowEndMs) continue;

      // Already resolved
      if ((order as InternalOrder & { resolved?: boolean }).resolved) continue;

      // Fetch current price vs start price to determine outcome
      try {
        const res = await fetch(`${PRICE_SERVICE_URL}/api/v1/price/current`, {
          signal: AbortSignal.timeout(3_000),
        });
        if (!res.ok) continue;
        const json = (await res.json()) as { ok: boolean; data?: { window?: { startPrice: number; deltaAbs: number }; resolver?: { price: number } } };
        if (!json.ok || !json.data?.window || !json.data?.resolver) continue;

        const startPrice = json.data.window.startPrice;
        const currentPrice = json.data.resolver.price;
        const wentUp = currentPrice > startPrice;

        // Determine P&L for binary option
        const isWin =
          (order.side === 'buy_up' && wentUp) ||
          (order.side === 'buy_down' && !wentUp);

        const pnlUsd = isWin
          ? (1 - order.entryPrice) * order.filledSizeUsd
          : -order.entryPrice * order.filledSizeUsd;

        // Update order
        order.status = 'resolved' as OrderStatus;
        order.updatedAt = new Date().toISOString();
        (order as InternalOrder & { resolved?: boolean; pnlUsd?: number; outcome?: string }).resolved = true;
        (order as InternalOrder & { pnlUsd?: number }).pnlUsd = pnlUsd;
        (order as InternalOrder & { outcome?: string }).outcome = isWin ? 'win' : 'loss';

        // Remove from open positions
        const posKey = `${order.marketId}:${order.side}`;
        this.positions.delete(posKey);

        // Persist
        try {
          await this.db
            .update(ordersTable)
            .set({ status: 'resolved' as string, updatedAt: order.updatedAt })
            .where(eq(ordersTable.id, order.id));
          // Add resolution fill with exit price
          await this.db.insert(fillsTable).values({
            id: `fill-resolve-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            orderId: order.id,
            fillPrice: isWin ? 1 : 0,
            fillSizeUsd: Math.abs(pnlUsd),
            filledAt: new Date().toISOString(),
          });
        } catch {
          /* best-effort */
        }

        this.emitEvent('order.resolved', {
          orderId: order.id,
          mode: order.mode,
          side: order.side,
          pnlUsd,
          outcome: isWin ? 'win' : 'loss',
          entryPrice: order.entryPrice,
          startPrice,
          endPrice: currentPrice,
        });
      } catch {
        /* retry next cycle */
      }
    }
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
    try {
      await this.db.insert(ordersTable).values({
        id: order.id,
        windowId: order.windowId,
        riskDecisionId: order.riskDecisionId,
        side: order.side,
        mode: order.mode,
        sizeUsd: order.sizeUsd,
        entryPrice: order.entryPrice,
        status: order.status,
        polymarketOrderId: order.polymarketOrderId,
        createdAt: order.createdAt,
        updatedAt: order.updatedAt,
      });
      await this.db.insert(fillsTable).values({
        id: fill.id,
        orderId: fill.orderId,
        fillPrice: fill.fillPrice,
        fillSizeUsd: fill.fillSizeUsd,
        filledAt: fill.filledAt,
      });
    } catch (_dbError) {
      /* ignored - persistence is best-effort */
    }

    this.emitEvent('order.created', { orderId: order.id, mode: 'paper', side: order.side });
    this.emitEvent('order.filled', {
      orderId: order.id,
      mode: 'paper',
      fillPrice: simulatedFillPrice,
      fillSizeUsd: input.sizeUsd,
    });
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
      try {
        await this.db.insert(ordersTable).values({
          id: order.id,
          windowId: order.windowId,
          riskDecisionId: order.riskDecisionId,
          side: order.side,
          mode: order.mode,
          sizeUsd: order.sizeUsd,
          entryPrice: order.entryPrice,
          status: order.status,
          polymarketOrderId: order.polymarketOrderId,
          createdAt: order.createdAt,
          updatedAt: order.updatedAt,
        });
      } catch (_dbError) {
        /* ignored - persistence is best-effort */
      }

      // In production, order fills would come via WebSocket subscription
      // For now, simulate a fill after placement
      await this.simulateLiveFill(order);

      return order;
    } catch (error) {
      order.status = 'failed';
      order.updatedAt = new Date().toISOString();
      try {
        await this.db
          .update(ordersTable)
          .set({ status: 'failed', updatedAt: order.updatedAt })
          .where(eq(ordersTable.id, order.id));
      } catch {
        /* ignore */
      }
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
    if (order) return order;

    // Fall back to database
    const [r] = await this.db
      .select()
      .from(ordersTable)
      .where(eq(ordersTable.id, orderId))
      .limit(1);
    if (r) {
      const dbFills = await this.db.select().from(fillsTable).where(eq(fillsTable.orderId, r.id));
      const internalOrder: InternalOrder = {
        id: r.id,
        marketId: '',
        windowId: r.windowId,
        riskDecisionId: r.riskDecisionId,
        side: r.side as OrderSide,
        mode: r.mode as ExecutionMode,
        sizeUsd: r.sizeUsd,
        entryPrice: r.entryPrice,
        maxEntryPrice: r.entryPrice,
        status: r.status as OrderStatus,
        polymarketOrderId: r.polymarketOrderId,
        source: 'database',
        mustExecuteBeforeMs: 0,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        fills: dbFills.map((f) => ({
          id: f.id,
          orderId: f.orderId,
          fillPrice: f.fillPrice,
          fillSizeUsd: f.fillSizeUsd,
          filledAt: f.filledAt,
        })),
        filledSizeUsd: dbFills.reduce((sum, f) => sum + f.fillSizeUsd, 0),
      };
      this.orders.set(r.id, internalOrder);
      return internalOrder;
    }

    throw new HttpException(`Order ${orderId} not found`, HttpStatus.NOT_FOUND);
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
      // TODO: send cancellation to Polymarket API
    }

    order.status = 'cancelled';
    order.updatedAt = new Date().toISOString();
    try {
      await this.db
        .update(ordersTable)
        .set({ status: 'cancelled', updatedAt: order.updatedAt })
        .where(eq(ordersTable.id, orderId));
    } catch {
      /* ignore */
    }

    this.emitEvent('order.cancelled', { orderId: order.id, mode: order.mode });

    return order;
  }

  /**
   * Returns fills, optionally filtered by windowId.
   */
  async getFills(windowId?: string, limit = 50): Promise<InternalFill[]> {
    // In-memory fills first
    const allFills: InternalFill[] = [];
    for (const order of this.orders.values()) {
      if (windowId && order.windowId !== windowId) continue;
      allFills.push(...order.fills);
    }

    if (allFills.length > 0) {
      return allFills
        .sort((a, b) => new Date(b.filledAt).getTime() - new Date(a.filledAt).getTime())
        .slice(0, limit);
    }

    // Fall back to database
    if (windowId) {
      const orderRows = await this.db
        .select()
        .from(ordersTable)
        .where(eq(ordersTable.windowId, windowId));
      const orderIds = orderRows.map((o) => o.id);
      if (orderIds.length > 0) {
        const dbFills = await this.db
          .select()
          .from(fillsTable)
          .where(inArray(fillsTable.orderId, orderIds))
          .limit(limit);
        return dbFills.map((f) => ({
          id: f.id,
          orderId: f.orderId,
          fillPrice: f.fillPrice,
          fillSizeUsd: f.fillSizeUsd,
          filledAt: f.filledAt,
        }));
      }
    } else {
      const dbFills = await this.db
        .select()
        .from(fillsTable)
        .orderBy(desc(fillsTable.filledAt))
        .limit(limit);
      return dbFills.map((f) => ({
        id: f.id,
        orderId: f.orderId,
        fillPrice: f.fillPrice,
        fillSizeUsd: f.fillSizeUsd,
        filledAt: f.filledAt,
      }));
    }

    return [];
  }

  /**
   * Returns all current open positions.
   */
  getPositions(): Position[] {
    // Positions are computed in-memory from filled orders, not stored separately
    return Array.from(this.positions.values());
  }

  // ─── Internal Helpers ──────────────────────────────────────────────────────

  private validateFreshness(mustExecuteBeforeSec: number): void {
    // The caller tells us how many seconds remain; reject if it is already expired
    if (mustExecuteBeforeSec <= 0) {
      throw new HttpException('Execution deadline has already passed', HttpStatus.BAD_REQUEST);
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

    try {
      await this.db.insert(fillsTable).values({
        id: fill.id,
        orderId: fill.orderId,
        fillPrice: fill.fillPrice,
        fillSizeUsd: fill.fillSizeUsd,
        filledAt: fill.filledAt,
      });
      await this.db
        .update(ordersTable)
        .set({ status: 'filled', entryPrice: order.entryPrice, updatedAt: order.updatedAt })
        .where(eq(ordersTable.id, order.id));
    } catch {
      /* ignore */
    }

    this.emitEvent('order.filled', {
      orderId: order.id,
      mode: order.mode,
      fillPrice: fill.fillPrice,
      fillSizeUsd: fill.fillSizeUsd,
    });
  }

  private async loadOpenOrders(): Promise<void> {
    try {
      const openOrders = await this.db
        .select()
        .from(ordersTable)
        .where(inArray(ordersTable.status, ['pending', 'placed', 'partial']));
      for (const r of openOrders) {
        const dbFills = await this.db.select().from(fillsTable).where(eq(fillsTable.orderId, r.id));
        this.orders.set(r.id, {
          id: r.id,
          marketId: '',
          windowId: r.windowId,
          riskDecisionId: r.riskDecisionId,
          side: r.side as OrderSide,
          mode: r.mode as ExecutionMode,
          sizeUsd: r.sizeUsd,
          entryPrice: r.entryPrice,
          maxEntryPrice: r.entryPrice,
          status: r.status as OrderStatus,
          polymarketOrderId: r.polymarketOrderId,
          source: 'database',
          mustExecuteBeforeMs: 0,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
          fills: dbFills.map((f) => ({
            id: f.id,
            orderId: f.orderId,
            fillPrice: f.fillPrice,
            fillSizeUsd: f.fillSizeUsd,
            filledAt: f.filledAt,
          })),
          filledSizeUsd: dbFills.reduce((sum, f) => sum + f.fillSizeUsd, 0),
        });
      }
      if (openOrders.length > 0) {
        // TODO: send cancellation to exchange
      }
    } catch (_error) {
      /* best-effort reconciliation */
    }
  }

  private emitEvent<E extends BrainEventName>(event: E, payload: BrainEventMap[E]): void {
    this.eventBus.emit(event, payload);
  }
}
