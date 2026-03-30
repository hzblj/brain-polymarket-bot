import { createDb } from '@brain/database';
import { EventBus } from '@brain/events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DerivativesFeedService } from './derivatives-feed.service';

function createMockLogger(): any {
  const noop = () => {};
  const logger = {
    log: noop, info: noop, error: noop, warn: noop,
    debug: noop, verbose: noop, fatal: noop, child: () => logger,
  };
  return logger;
}

describe('DerivativesFeedService', () => {
  let service: DerivativesFeedService;
  let eventBus: EventBus;

  beforeEach(() => {
    vi.stubGlobal('WebSocket', undefined);
    const db = createDb(':memory:');
    eventBus = new EventBus();
    service = new DerivativesFeedService(db, eventBus, createMockLogger());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    eventBus.onModuleDestroy();
  });

  describe('getCurrentFeatures', () => {
    it('returns default features when no data', () => {
      const f = service.getCurrentFeatures();
      expect(f.fundingRate).toBe(0);
      expect(f.openInterestUsd).toBe(0);
      expect(f.longLiquidationUsd).toBe(0);
      expect(f.shortLiquidationUsd).toBe(0);
      expect(f.liquidationImbalance).toBe(0);
      expect(f.liquidationIntensity).toBe(0);
      expect(f.derivativesSentiment).toBe(0);
    });

    it('features have correct bounds', () => {
      const f = service.getCurrentFeatures();
      expect(f.fundingPressure).toBeGreaterThanOrEqual(-1);
      expect(f.fundingPressure).toBeLessThanOrEqual(1);
      expect(f.oiTrend).toBeGreaterThanOrEqual(-1);
      expect(f.oiTrend).toBeLessThanOrEqual(1);
      expect(f.liquidationImbalance).toBeGreaterThanOrEqual(-1);
      expect(f.liquidationImbalance).toBeLessThanOrEqual(1);
      expect(f.liquidationIntensity).toBeGreaterThanOrEqual(0);
      expect(f.liquidationIntensity).toBeLessThanOrEqual(1);
      expect(f.derivativesSentiment).toBeGreaterThanOrEqual(-1);
      expect(f.derivativesSentiment).toBeLessThanOrEqual(1);
    });
  });

  describe('getRecentLiquidations', () => {
    it('returns empty array when no liquidations', () => {
      expect(service.getRecentLiquidations()).toEqual([]);
    });
  });

  describe('getHistory', () => {
    it('returns empty when no snapshots', () => {
      expect(service.getHistory()).toEqual([]);
    });
  });

  describe('getStatus', () => {
    it('returns disconnected status initially', () => {
      const status = service.getStatus();
      expect(status.wsConnected).toBe(false);
      expect(status.fundingRate).toBe(0);
      expect(status.liquidationCount).toBe(0);
    });
  });
});
