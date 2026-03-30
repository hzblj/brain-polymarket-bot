import { createHash } from 'node:crypto';
import { createDb } from '@brain/database';
import {
  marketConfigs,
  strategies,
  strategyAssignments,
  strategyVersions,
} from '@brain/database';
import { validateStrategyVersionConfig } from '@brain/schemas';
import type { StrategyVersionConfig } from '@brain/types';
import { eq } from 'drizzle-orm';

// ─── Default Market Config ──────────────────────────────────────────────────

const DEFAULT_MARKET_CONFIG = {
  label: 'Bitcoin 5m Up/Down',
  asset: 'BTC',
  marketType: 'UP_DOWN',
  windowSec: 300,
  resolverType: 'polymarket',
  resolverSymbol: 'BTCUSDT',
  defaultEnabled: true,
  isActive: true,
};

// ─── Default Strategy ───────────────────────────────────────────────────────

const DEFAULT_STRATEGY_KEY = 'btc-5m-momentum';

const DEFAULT_STRATEGY_IDENTITY = {
  key: DEFAULT_STRATEGY_KEY,
  name: 'BTC 5m Momentum',
  description:
    'Default conservative momentum strategy for Bitcoin 5-minute Up/Down markets.',
  status: 'active' as const,
  isDefault: true,
};

const DEFAULT_STRATEGY_VERSION_CONFIG: StrategyVersionConfig = {
  id: 'btc-5m-momentum-v1',
  label: 'BTC 5m Momentum v1',
  marketSelector: {
    asset: 'BTC',
    marketType: 'UP_DOWN',
    windowSec: 300,
  },
  agentProfile: {
    regimeAgentProfile: 'regime-default-v1',
    edgeAgentProfile: 'edge-momentum-v1',
    supervisorAgentProfile: 'supervisor-conservative-v1',
  },
  decisionPolicy: {
    allowedDecisions: ['TRADE_LONG', 'TRADE_SHORT', 'NO_TRADE'],
    minConfidence: 0.7,
  },
  filters: {
    maxSpreadBps: 250,
    minDepthScore: 0.6,
    minTimeToCloseSec: 15,
    maxTimeToCloseSec: 90,
  },
  riskProfile: {
    maxSizeUsd: 20,
    dailyLossLimitUsd: 50,
    maxTradesPerWindow: 1,
  },
  executionPolicy: {
    entryWindowStartSec: 90,
    entryWindowEndSec: 10,
    mode: 'paper',
  },
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function computeChecksum(config: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(config)).digest('hex');
}

// ─── Seed Function ──────────────────────────────────────────────────────────

export async function seed(dbPath?: string) {
  const resolvedPath = dbPath ?? process.env.DATABASE_PATH ?? './data/brain.sqlite';
  const db = createDb(resolvedPath);

  // Validate strategy config before inserting
  validateStrategyVersionConfig(DEFAULT_STRATEGY_VERSION_CONFIG);

  // 1. Upsert default market config
  const existingMarketConfigs = await db
    .select()
    .from(marketConfigs)
    .where(eq(marketConfigs.label, DEFAULT_MARKET_CONFIG.label))
    .limit(1);

  let marketConfigId: string;
  if (existingMarketConfigs.length > 0) {
    marketConfigId = existingMarketConfigs[0]!.id;
    console.log(`  Market config already exists: ${marketConfigId}`);
  } else {
    const [inserted] = await db
      .insert(marketConfigs)
      .values(DEFAULT_MARKET_CONFIG)
      .returning({ id: marketConfigs.id });
    marketConfigId = inserted!.id;
    console.log(`  Created market config: ${marketConfigId}`);
  }

  // 2. Upsert default strategy identity
  const existingStrategies = await db
    .select()
    .from(strategies)
    .where(eq(strategies.key, DEFAULT_STRATEGY_KEY))
    .limit(1);

  let strategyId: string;
  if (existingStrategies.length > 0) {
    strategyId = existingStrategies[0]!.id;
    console.log(`  Strategy already exists: ${strategyId}`);
  } else {
    const [inserted] = await db
      .insert(strategies)
      .values(DEFAULT_STRATEGY_IDENTITY)
      .returning({ id: strategies.id });
    strategyId = inserted!.id;
    console.log(`  Created strategy: ${strategyId}`);
  }

  // 3. Create or verify v1 strategy version
  const checksum = computeChecksum(
    DEFAULT_STRATEGY_VERSION_CONFIG as unknown as Record<string, unknown>,
  );

  const existingVersions = await db
    .select()
    .from(strategyVersions)
    .where(eq(strategyVersions.strategyId, strategyId))
    .limit(1);

  let versionId: string;
  if (existingVersions.length > 0 && existingVersions[0]!.version === 1) {
    versionId = existingVersions[0]!.id;
    console.log(`  Strategy version v1 already exists: ${versionId}`);
  } else {
    const [inserted] = await db
      .insert(strategyVersions)
      .values({
        strategyId,
        version: 1,
        configJson: DEFAULT_STRATEGY_VERSION_CONFIG as unknown as Record<string, unknown>,
        checksum,
      })
      .returning({ id: strategyVersions.id });
    versionId = inserted!.id;
    console.log(`  Created strategy version v1: ${versionId}`);
  }

  // 4. Activate assignment for bitcoin-5m market
  const existingAssignments = await db
    .select()
    .from(strategyAssignments)
    .where(eq(strategyAssignments.marketConfigId, marketConfigId))
    .limit(1);

  if (existingAssignments.length > 0) {
    console.log(`  Assignment already exists: ${existingAssignments[0]!.id}`);
  } else {
    const [inserted] = await db
      .insert(strategyAssignments)
      .values({
        marketConfigId,
        strategyVersionId: versionId,
        priority: 0,
        isActive: true,
      })
      .returning({ id: strategyAssignments.id });
    console.log(`  Created assignment: ${inserted!.id}`);
  }

  console.log('\nSeed complete:');
  console.log(`  Market config: ${DEFAULT_MARKET_CONFIG.label} (${marketConfigId})`);
  console.log(`  Strategy: ${DEFAULT_STRATEGY_IDENTITY.name} (${strategyId})`);
  console.log(`  Version: v1 (${versionId})`);
  console.log(`  Mode: paper`);

  return { marketConfigId, strategyId, versionId };
}

// ─── CLI Entry Point ────────────────────────────────────────────────────────

if (process.argv[1] && import.meta.url.endsWith(process.argv[1])) {
  console.log('Seeding database...\n');
  seed()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Seed failed:', err);
      process.exit(1);
    });
}
