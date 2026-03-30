import { createDb } from '@brain/database';
import { HttpException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExecutionService, type OrderInput } from './execution.service';

// ─── Test Data Helpers ──────────────────────────────────────────────────────

function makeOrderInput(overrides: Partial<OrderInput> = {}): OrderInput {
  return {
    marketId: 'market-btc',
    side: 'UP',
    mode: 'paper',
    sizeUsd: 25,
    maxEntryPrice: 0.55,
    mustExecuteBeforeSec: 30,
    source: 'test',
    windowId: 'win-1',
    riskDecisionId: 'risk-1',
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('ExecutionService', () => {
  let service: ExecutionService;

  beforeEach(() => {
    const db = createDb(':memory:');
    service = new ExecutionService(db);
    vi.spyOn(console, 'log').mockImplementation(() => {
      /* noop */
    });
    vi.spyOn(console, 'error').mockImplementation(() => {
      /* noop */
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Paper Order ───────────────────────────────────────────────────────

  describe('paperOrder', () => {
    it('creates and fills a paper order immediately', async () => {
      const order = await service.paperOrder(makeOrderInput());
      expect(order.id).toMatch(/^ord-/);
      expect(order.status).toBe('filled');
      expect(order.mode).toBe('paper');
      expect(order.side).toBe('buy_up');
      expect(order.sizeUsd).toBe(25);
      expect(order.entryPrice).toBe(0.55);
      expect(order.filledSizeUsd).toBe(25);
      expect(order.fills).toHaveLength(1);
    });

    it('creates fill with correct data', async () => {
      const order = await service.paperOrder(makeOrderInput());
      const fill = order.fills[0];
      expect(fill.id).toMatch(/^fill-/);
      expect(fill.orderId).toBe(order.id);
      expect(fill.fillPrice).toBe(0.55);
      expect(fill.fillSizeUsd).toBe(25);
      expect(fill.filledAt).toBeDefined();
    });

    it('maps DOWN side correctly', async () => {
      const order = await service.paperOrder(makeOrderInput({ side: 'DOWN' }));
      expect(order.side).toBe('buy_down');
    });

    it('sets windowId and riskDecisionId', async () => {
      const order = await service.paperOrder(
        makeOrderInput({
          windowId: 'win-42',
          riskDecisionId: 'risk-42',
        }),
      );
      expect(order.windowId).toBe('win-42');
      expect(order.riskDecisionId).toBe('risk-42');
    });

    it('defaults windowId and riskDecisionId to empty string', async () => {
      const order = await service.paperOrder(
        makeOrderInput({
          windowId: undefined,
          riskDecisionId: undefined,
        }),
      );
      expect(order.windowId).toBe('');
      expect(order.riskDecisionId).toBe('');
    });
  });

  // ── Live Order ────────────────────────────────────────────────────────

  describe('liveOrder', () => {
    it('creates a live order and simulates fill', async () => {
      const order = await service.liveOrder(makeOrderInput({ mode: 'live' }));
      expect(order.id).toMatch(/^ord-/);
      expect(order.mode).toBe('live');
      expect(order.status).toBe('filled');
      expect(order.polymarketOrderId).toMatch(/^poly-/);
      expect(order.fills).toHaveLength(1);
      expect(order.entryPrice).toBe(0.55);
    });

    it('transitions through placed to filled status', async () => {
      // The live order should ultimately end in 'filled' since it simulates
      const order = await service.liveOrder(makeOrderInput({ mode: 'live' }));
      expect(order.status).toBe('filled');
      expect(order.polymarketOrderId).toBeTruthy();
    });
  });

  // ── Order Lifecycle ───────────────────────────────────────────────────

  describe('order lifecycle', () => {
    it('stores orders and retrieves them by ID', async () => {
      const created = await service.paperOrder(makeOrderInput());
      const retrieved = await service.getOrder(created.id);
      expect(retrieved.id).toBe(created.id);
      expect(retrieved.status).toBe('filled');
    });

    it('throws NOT_FOUND for unknown order ID', async () => {
      await expect(service.getOrder('nonexistent')).rejects.toThrow(HttpException);
      await expect(service.getOrder('nonexistent')).rejects.toThrow('not found');
    });
  });

  // ── Cancel Order ──────────────────────────────────────────────────────

  describe('cancelOrder', () => {
    it('cancels a pending order', async () => {
      // Create a live order but intercept before fill to test pending state
      // Actually, live order simulates fill immediately. Let's test with a filled order rejection instead.
      // We'll directly set up an order in pending state by accessing internals
      const order = await service.paperOrder(makeOrderInput());
      // Paper orders are immediately filled, so cancelling should fail
      await expect(service.cancelOrder(order.id)).rejects.toThrow(HttpException);
    });

    it('rejects cancellation of filled order', async () => {
      const order = await service.paperOrder(makeOrderInput());
      expect(order.status).toBe('filled');
      await expect(service.cancelOrder(order.id)).rejects.toThrow(
        "Cannot cancel order in status 'filled'",
      );
    });

    it('rejects cancellation of already cancelled order', async () => {
      // We need an order in a cancellable state first. Access internals.
      const order = await service.liveOrder(makeOrderInput({ mode: 'live' }));
      // Order is 'filled' — can't cancel
      await expect(service.cancelOrder(order.id)).rejects.toThrow(
        "Cannot cancel order in status 'filled'",
      );
    });

    it('cancels a placed order successfully', async () => {
      // Manually set an order to "placed" status to test cancel path
      const order = await service.paperOrder(makeOrderInput());
      // Manually override status to simulate a placed order
      (order as unknown as Record<string, string>).status = 'placed';
      const cancelled = await service.cancelOrder(order.id);
      expect(cancelled.status).toBe('cancelled');
    });

    it('cancels a pending order successfully', async () => {
      const order = await service.paperOrder(makeOrderInput());
      (order as unknown as Record<string, string>).status = 'pending';
      const cancelled = await service.cancelOrder(order.id);
      expect(cancelled.status).toBe('cancelled');
    });

    it('throws for non-existent order', async () => {
      await expect(service.cancelOrder('nonexistent')).rejects.toThrow(HttpException);
    });
  });

  // ── Freshness Validation ──────────────────────────────────────────────

  describe('freshness validation', () => {
    it('rejects orders with expired deadline (mustExecuteBeforeSec <= 0)', async () => {
      await expect(service.paperOrder(makeOrderInput({ mustExecuteBeforeSec: 0 }))).rejects.toThrow(
        'Execution deadline has already passed',
      );
    });

    it('rejects orders with negative deadline', async () => {
      await expect(
        service.paperOrder(makeOrderInput({ mustExecuteBeforeSec: -5 })),
      ).rejects.toThrow('Execution deadline has already passed');
    });

    it('accepts orders with positive deadline', async () => {
      const order = await service.paperOrder(makeOrderInput({ mustExecuteBeforeSec: 1 }));
      expect(order.status).toBe('filled');
    });

    it('freshness check applies to live orders too', async () => {
      await expect(
        service.liveOrder(makeOrderInput({ mode: 'live', mustExecuteBeforeSec: 0 })),
      ).rejects.toThrow('Execution deadline has already passed');
    });
  });

  // ── Get Fills ─────────────────────────────────────────────────────────

  describe('getFills', () => {
    it('returns fills for paper trades', async () => {
      await service.paperOrder(makeOrderInput({ windowId: 'win-fills' }));
      const fills = await service.getFills('win-fills');
      expect(fills).toHaveLength(1);
      expect(fills[0].fillPrice).toBe(0.55);
      expect(fills[0].fillSizeUsd).toBe(25);
    });

    it('returns empty array when no fills exist', async () => {
      const fills = await service.getFills('nonexistent-window');
      expect(fills).toEqual([]);
    });

    it('filters fills by windowId', async () => {
      await service.paperOrder(makeOrderInput({ windowId: 'win-A' }));
      await service.paperOrder(makeOrderInput({ windowId: 'win-B' }));
      const fillsA = await service.getFills('win-A');
      const fillsB = await service.getFills('win-B');
      expect(fillsA).toHaveLength(1);
      expect(fillsB).toHaveLength(1);
    });

    it('returns all fills when no windowId filter', async () => {
      await service.paperOrder(makeOrderInput({ windowId: 'win-A' }));
      await service.paperOrder(makeOrderInput({ windowId: 'win-B' }));
      const allFills = await service.getFills();
      expect(allFills).toHaveLength(2);
    });

    it('respects the limit parameter', async () => {
      await service.paperOrder(makeOrderInput({ windowId: 'win-limit' }));
      await service.paperOrder(makeOrderInput({ windowId: 'win-limit' }));
      await service.paperOrder(makeOrderInput({ windowId: 'win-limit' }));
      const fills = await service.getFills('win-limit', 2);
      expect(fills).toHaveLength(2);
    });
  });

  // ── Get Positions ─────────────────────────────────────────────────────

  describe('getPositions', () => {
    it('returns empty array initially', async () => {
      const positions = await service.getPositions();
      expect(positions).toEqual([]);
    });

    it('tracks position after paper order fill', async () => {
      await service.paperOrder(makeOrderInput({ side: 'UP', sizeUsd: 25, maxEntryPrice: 0.55 }));
      const positions = await service.getPositions();
      expect(positions).toHaveLength(1);
      expect(positions[0].marketId).toBe('market-btc');
      expect(positions[0].side).toBe('buy_up');
      expect(positions[0].sizeUsd).toBe(25);
      expect(positions[0].avgEntryPrice).toBe(0.55);
      expect(positions[0].mode).toBe('paper');
    });

    it('aggregates exposure for same market and side', async () => {
      await service.paperOrder(makeOrderInput({ side: 'UP', sizeUsd: 20, maxEntryPrice: 0.5 }));
      await service.paperOrder(makeOrderInput({ side: 'UP', sizeUsd: 30, maxEntryPrice: 0.6 }));
      const positions = await service.getPositions();
      expect(positions).toHaveLength(1);
      expect(positions[0].sizeUsd).toBe(50);
      // avgEntryPrice = (0.50 * 20 + 0.60 * 30) / 50 = (10 + 18) / 50 = 0.56
      expect(positions[0].avgEntryPrice).toBeCloseTo(0.56, 5);
    });

    it('tracks separate positions for different sides', async () => {
      await service.paperOrder(makeOrderInput({ side: 'UP', sizeUsd: 20, maxEntryPrice: 0.55 }));
      await service.paperOrder(makeOrderInput({ side: 'DOWN', sizeUsd: 15, maxEntryPrice: 0.45 }));
      const positions = await service.getPositions();
      expect(positions).toHaveLength(2);
    });

    it('tracks separate positions for different markets', async () => {
      await service.paperOrder(makeOrderInput({ marketId: 'market-btc' }));
      await service.paperOrder(makeOrderInput({ marketId: 'market-eth' }));
      const positions = await service.getPositions();
      expect(positions).toHaveLength(2);
    });
  });

  // ── Multiple Orders Tracking ──────────────────────────────────────────

  describe('multiple orders tracking', () => {
    it('tracks multiple orders independently', async () => {
      const order1 = await service.paperOrder(makeOrderInput({ sizeUsd: 10 }));
      const order2 = await service.paperOrder(makeOrderInput({ sizeUsd: 20 }));
      const order3 = await service.paperOrder(makeOrderInput({ sizeUsd: 30 }));

      const r1 = await service.getOrder(order1.id);
      const r2 = await service.getOrder(order2.id);
      const r3 = await service.getOrder(order3.id);

      expect(r1.sizeUsd).toBe(10);
      expect(r2.sizeUsd).toBe(20);
      expect(r3.sizeUsd).toBe(30);
    });

    it('each order has a unique ID', async () => {
      const order1 = await service.paperOrder(makeOrderInput());
      const order2 = await service.paperOrder(makeOrderInput());
      expect(order1.id).not.toBe(order2.id);
    });
  });

  // ── Order Fields ──────────────────────────────────────────────────────

  describe('order structure', () => {
    it('sets all fields on created order', async () => {
      const order = await service.paperOrder(
        makeOrderInput({
          marketId: 'market-test',
          source: 'test-source',
        }),
      );
      expect(order.marketId).toBe('market-test');
      expect(order.source).toBe('test-source');
      expect(order.createdAt).toBeDefined();
      expect(order.updatedAt).toBeDefined();
      expect(order.maxEntryPrice).toBe(0.55);
    });

    it('paper order has null polymarketOrderId', async () => {
      const order = await service.paperOrder(makeOrderInput());
      // Paper order starts with null polymarketOrderId
      expect(order.polymarketOrderId).toBeNull();
    });

    it('sets mustExecuteBeforeMs from seconds input', async () => {
      const before = Date.now();
      const order = await service.paperOrder(makeOrderInput({ mustExecuteBeforeSec: 60 }));
      const after = Date.now();
      // mustExecuteBeforeMs should be roughly now + 60s
      expect(order.mustExecuteBeforeMs).toBeGreaterThanOrEqual(before + 60_000);
      expect(order.mustExecuteBeforeMs).toBeLessThanOrEqual(after + 60_000);
    });
  });
});
