import { createDb, type DbClient, marketConfigs, strategies, strategyAssignments, strategyVersions } from '@brain/database';
import { createTestStrategyVersionConfig } from '@brain/testing';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StrategyService } from './strategy.service';

describe('StrategyService', () => {
  let db: DbClient;
  let service: StrategyService;
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `brain-test-${randomUUID()}.sqlite`);
    db = createDb(dbPath);
    service = new StrategyService(db);
  });

  afterEach(() => {
    try {
      unlinkSync(dbPath);
      unlinkSync(`${dbPath}-wal`);
      unlinkSync(`${dbPath}-shm`);
    } catch {}
  });

  async function seedDefaults() {
    const [mc] = await db.insert(marketConfigs).values({
      label: 'Bitcoin 5m Up/Down',
      asset: 'BTC',
      marketType: 'UP_DOWN',
      windowSec: 300,
      resolverType: 'polymarket',
      resolverSymbol: 'BTCUSDT',
      defaultEnabled: true,
      isActive: true,
    }).returning();

    const [strat] = await db.insert(strategies).values({
      key: 'btc-5m-momentum',
      name: 'BTC 5m Momentum',
      description: 'Default strategy',
      status: 'active',
      isDefault: true,
    }).returning();

    const config = createTestStrategyVersionConfig({
      id: 'btc-5m-momentum-v1',
      label: 'BTC 5m Momentum v1',
    });

    const [version] = await db.insert(strategyVersions).values({
      strategyId: strat!.id,
      version: 1,
      configJson: config as unknown as Record<string, unknown>,
      checksum: 'test-checksum',
    }).returning();

    const [assignment] = await db.insert(strategyAssignments).values({
      marketConfigId: mc!.id,
      strategyVersionId: version!.id,
      priority: 0,
      isActive: true,
    }).returning();

    return { mc: mc!, strat: strat!, version: version!, assignment: assignment! };
  }

  describe('getActiveStrategy', () => {
    it('returns null when no market configs exist', async () => {
      const result = await service.getActiveStrategy();
      expect(result).toBeNull();
    });

    it('returns null when no assignments exist', async () => {
      await db.insert(marketConfigs).values({
        label: 'Test',
        asset: 'BTC',
        marketType: 'UP_DOWN',
        windowSec: 300,
        resolverType: 'polymarket',
        resolverSymbol: 'BTCUSDT',
      });
      const result = await service.getActiveStrategy();
      expect(result).toBeNull();
    });

    it('returns active strategy context after seeding', async () => {
      await seedDefaults();
      const result = await service.getActiveStrategy();
      expect(result).not.toBeNull();
      expect(result!.strategyKey).toBe('btc-5m-momentum');
      expect(result!.version).toBe(1);
      expect(result!.decisionPolicy.minConfidence).toBe(0.7);
      expect(result!.filters.maxSpreadBps).toBe(250);
      expect(result!.riskProfile.maxSizeUsd).toBe(20);
      expect(result!.executionPolicy.mode).toBe('paper');
    });

    it('returns strategy for specific market config', async () => {
      const { mc } = await seedDefaults();
      const result = await service.getActiveStrategy(mc.id);
      expect(result).not.toBeNull();
      expect(result!.strategyKey).toBe('btc-5m-momentum');
    });
  });

  describe('switchStrategy', () => {
    it('switches the active strategy assignment', async () => {
      const { mc, strat } = await seedDefaults();

      // Create a new version
      const config = createTestStrategyVersionConfig({ id: 'v2', label: 'v2' });
      const [v2] = await db.insert(strategyVersions).values({
        strategyId: strat.id,
        version: 2,
        configJson: config as unknown as Record<string, unknown>,
        checksum: 'checksum-v2',
      }).returning();

      await service.switchStrategy(mc.id, v2!.id);
      const result = await service.getActiveStrategy(mc.id);
      expect(result!.version).toBe(2);
    });

    it('throws for non-existent version', async () => {
      const { mc } = await seedDefaults();
      await expect(
        service.switchStrategy(mc.id, 'non-existent'),
      ).rejects.toThrow('Strategy version not found');
    });

    it('throws for non-existent market config', async () => {
      const { version } = await seedDefaults();
      await expect(
        service.switchStrategy('non-existent', version.id),
      ).rejects.toThrow('Market config not found');
    });
  });

  describe('resetToDefault', () => {
    it('resets to default strategy', async () => {
      const { mc, strat } = await seedDefaults();

      // Create and switch to a v2
      const config = createTestStrategyVersionConfig({ id: 'v2', label: 'v2' });
      const [v2] = await db.insert(strategyVersions).values({
        strategyId: strat.id,
        version: 2,
        configJson: config as unknown as Record<string, unknown>,
        checksum: 'checksum-v2',
      }).returning();

      await service.switchStrategy(mc.id, v2!.id);
      let result = await service.getActiveStrategy(mc.id);
      expect(result!.version).toBe(2);

      // Reset
      result = await service.resetToDefault();
      expect(result).not.toBeNull();
      // Should go back to the latest version of the default strategy (v2 is still latest)
      expect(result!.version).toBe(2);
    });
  });

  describe('createStrategy', () => {
    it('creates a new strategy identity', async () => {
      const result = await service.createStrategy({
        key: 'new-strategy',
        name: 'New Strategy',
        description: 'A new strategy',
      });
      expect(result).toBeDefined();
      expect(result!.key).toBe('new-strategy');
      expect(result!.status).toBe('active');
      expect(result!.isDefault).toBe(false);
    });
  });

  describe('createVersion', () => {
    it('creates a new version with auto-increment', async () => {
      const { strat } = await seedDefaults();

      const config = createTestStrategyVersionConfig({ id: 'v2', label: 'v2' });
      const result = await service.createVersion(strat.id, config);
      expect(result).toBeDefined();
      expect(result!.version).toBe(2);
    });

    it('rejects invalid config', async () => {
      const { strat } = await seedDefaults();
      await expect(
        service.createVersion(strat.id, { invalid: true }),
      ).rejects.toThrow('Invalid strategy version config');
    });

    it('throws for non-existent strategy', async () => {
      const config = createTestStrategyVersionConfig();
      await expect(
        service.createVersion('non-existent', config),
      ).rejects.toThrow('Strategy not found');
    });
  });

  describe('deactivateStrategy', () => {
    it('deactivates a strategy', async () => {
      const { strat } = await seedDefaults();
      const result = await service.deactivateStrategy(strat.id);
      expect(result!.status).toBe('inactive');
    });

    it('throws for non-existent strategy', async () => {
      await expect(
        service.deactivateStrategy('non-existent'),
      ).rejects.toThrow('Strategy not found');
    });
  });

  describe('listStrategies', () => {
    it('returns all strategies', async () => {
      await seedDefaults();
      const result = await service.listStrategies();
      expect(result.length).toBe(1);
      expect(result[0]!.key).toBe('btc-5m-momentum');
    });
  });

  describe('listVersions', () => {
    it('returns versions for a strategy', async () => {
      const { strat } = await seedDefaults();
      const result = await service.listVersions(strat.id);
      expect(result.length).toBe(1);
      expect(result[0]!.version).toBe(1);
    });
  });
});
