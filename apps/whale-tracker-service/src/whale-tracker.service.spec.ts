import { createDb } from '@brain/database';
import { EventBus } from '@brain/events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WhaleTrackerService } from './whale-tracker.service';

// ─── Mock Logger ──────────────────────────────────────────────────────────────

function createMockLogger(): any {
  const noop = () => {};
  const logger = {
    log: noop,
    info: noop,
    error: noop,
    warn: noop,
    debug: noop,
    verbose: noop,
    fatal: noop,
    child: () => logger,
  };
  return logger;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('WhaleTrackerService', () => {
  let service: WhaleTrackerService;
  let eventBus: EventBus;

  beforeEach(() => {
    // Suppress WebSocket connection in tests
    vi.stubGlobal('WebSocket', undefined);

    const db = createDb(':memory:');
    eventBus = new EventBus();
    const mockLogger = createMockLogger();
    service = new WhaleTrackerService(db, eventBus, mockLogger);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    eventBus.onModuleDestroy();
  });

  describe('getCurrentFeatures', () => {
    it('returns default features when no transactions', () => {
      const features = service.getCurrentFeatures();

      expect(features.largeTransactionCount).toBe(0);
      expect(features.netExchangeFlowBtc).toBe(0);
      expect(features.exchangeFlowPressure).toBe(0);
      expect(features.whaleVolumeBtc).toBe(0);
      expect(features.abnormalActivityScore).toBe(0);
      expect(features.lastWhaleEventTime).toBeNull();
    });
  });

  describe('getRecentTransactions', () => {
    it('returns empty array when no transactions', () => {
      const txs = service.getRecentTransactions();
      expect(txs).toEqual([]);
    });

    it('respects the limit parameter', () => {
      const txs = service.getRecentTransactions(5);
      expect(txs.length).toBeLessThanOrEqual(5);
    });
  });

  describe('getHistory', () => {
    it('returns empty array when no snapshots', () => {
      const history = service.getHistory();
      expect(history).toEqual([]);
    });
  });

  describe('getStatus', () => {
    it('returns disconnected status when WebSocket is not connected', () => {
      const status = service.getStatus();
      expect(status.connected).toBe(false);
      expect(status.transactionCount).toBe(0);
    });
  });

  describe('feature computation', () => {
    it('default features have correct shape', () => {
      const features = service.getCurrentFeatures();

      expect(typeof features.largeTransactionCount).toBe('number');
      expect(typeof features.netExchangeFlowBtc).toBe('number');
      expect(typeof features.exchangeFlowPressure).toBe('number');
      expect(typeof features.whaleVolumeBtc).toBe('number');
      expect(typeof features.abnormalActivityScore).toBe('number');
      expect(features.exchangeFlowPressure).toBeGreaterThanOrEqual(-1);
      expect(features.exchangeFlowPressure).toBeLessThanOrEqual(1);
      expect(features.abnormalActivityScore).toBeGreaterThanOrEqual(0);
      expect(features.abnormalActivityScore).toBeLessThanOrEqual(1);
    });
  });
});
