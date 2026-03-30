import { createDb, marketConfigs, strategies, strategyAssignments, strategyVersions } from '@brain/database';
import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seed } from './seed';

describe('seed', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `brain-seed-test-${randomUUID()}.sqlite`);
  });

  afterEach(() => {
    try {
      unlinkSync(dbPath);
      unlinkSync(`${dbPath}-wal`);
      unlinkSync(`${dbPath}-shm`);
    } catch {}
  });

  it('seeds a fresh database with default data', async () => {
    const result = await seed(dbPath);

    expect(result.marketConfigId).toBeDefined();
    expect(result.strategyId).toBeDefined();
    expect(result.versionId).toBeDefined();

    // Verify data in DB
    const db = createDb(dbPath);

    const mcs = await db.select().from(marketConfigs);
    expect(mcs.length).toBe(1);
    expect(mcs[0]!.label).toBe('Bitcoin 5m Up/Down');
    expect(mcs[0]!.asset).toBe('BTC');
    expect(mcs[0]!.windowSec).toBe(300);
    expect(mcs[0]!.isActive).toBe(true);

    const strats = await db.select().from(strategies);
    expect(strats.length).toBe(1);
    expect(strats[0]!.key).toBe('btc-5m-momentum');
    expect(strats[0]!.isDefault).toBe(true);
    expect(strats[0]!.status).toBe('active');

    const versions = await db.select().from(strategyVersions);
    expect(versions.length).toBe(1);
    expect(versions[0]!.version).toBe(1);
    const config = versions[0]!.configJson as Record<string, unknown>;
    expect((config as { executionPolicy: { mode: string } }).executionPolicy.mode).toBe('paper');

    const assignments = await db.select().from(strategyAssignments);
    expect(assignments.length).toBe(1);
    expect(assignments[0]!.isActive).toBe(true);
  });

  it('is idempotent - running twice creates no duplicates', async () => {
    await seed(dbPath);
    await seed(dbPath);

    const db = createDb(dbPath);

    const mcs = await db.select().from(marketConfigs);
    expect(mcs.length).toBe(1);

    const strats = await db.select().from(strategies);
    expect(strats.length).toBe(1);

    const versions = await db.select().from(strategyVersions);
    expect(versions.length).toBe(1);

    const assignments = await db.select().from(strategyAssignments);
    expect(assignments.length).toBe(1);
  });
});
