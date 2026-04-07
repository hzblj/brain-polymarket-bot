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
    supervisorAgentProfile: 'supervisor-momentum-v1',
  },
  decisionPolicy: {
    allowedDecisions: ['TRADE_LONG', 'TRADE_SHORT', 'NO_TRADE'],
    minConfidence: 0.6,
  },
  filters: {
    maxSpreadBps: 150,
    minDepthScore: 0.4,
    minTimeToCloseSec: 30,
    maxTimeToCloseSec: 120,
    allowedRegimes: ['trending_up', 'trending_down'],
  },
  riskProfile: {
    maxSizeUsd: 0.5,
    dailyLossLimitUsd: 10,
    maxTradesPerWindow: 1,
  },
  executionPolicy: {
    entryWindowStartSec: 120,
    entryWindowEndSec: 15,
    mode: 'paper',
  },
};

// ─── Mean Reversion Strategy (Citadel / Renaissance style) ─────────────────

const MEAN_REVERSION_STRATEGY_KEY = 'btc-5m-mean-reversion';

const MEAN_REVERSION_STRATEGY_IDENTITY = {
  key: MEAN_REVERSION_STRATEGY_KEY,
  name: 'BTC 5m Mean Reversion',
  description:
    'Contrarian strategy that trades against overextended 5-minute moves, betting on snap-back to mean.',
  status: 'active' as const,
  isDefault: false,
};

const MEAN_REVERSION_VERSION_CONFIG: StrategyVersionConfig = {
  id: 'btc-5m-mean-reversion-v1',
  label: 'BTC 5m Mean Reversion v1',
  marketSelector: {
    asset: 'BTC',
    marketType: 'UP_DOWN',
    windowSec: 300,
  },
  agentProfile: {
    regimeAgentProfile: 'regime-default-v1',
    edgeAgentProfile: 'edge-mean-reversion-v1',
    supervisorAgentProfile: 'supervisor-mean-reversion-v1',
  },
  decisionPolicy: {
    allowedDecisions: ['TRADE_LONG', 'TRADE_SHORT', 'NO_TRADE'],
    minConfidence: 0.58,
  },
  filters: {
    maxSpreadBps: 180,
    minDepthScore: 0.35,
    minTimeToCloseSec: 40,
    maxTimeToCloseSec: 180,
    allowedRegimes: ['mean_reverting', 'quiet'],
  },
  riskProfile: {
    maxSizeUsd: 0.35,
    dailyLossLimitUsd: 10,
    maxTradesPerWindow: 1,
  },
  executionPolicy: {
    entryWindowStartSec: 180,
    entryWindowEndSec: 30,
    mode: 'paper',
  },
};

// ─── Basis Arbitrage Strategy (Jump Trading / HFT style) ────────────────────

const BASIS_ARB_STRATEGY_KEY = 'btc-5m-basis-arb';

const BASIS_ARB_STRATEGY_IDENTITY = {
  key: BASIS_ARB_STRATEGY_KEY,
  name: 'BTC 5m Basis Arb',
  description:
    'Cross-venue arbitrage exploiting price lag between Binance/Coinbase and Polymarket token prices.',
  status: 'active' as const,
  isDefault: false,
};

const BASIS_ARB_VERSION_CONFIG: StrategyVersionConfig = {
  id: 'btc-5m-basis-arb-v1',
  label: 'BTC 5m Basis Arb v1',
  marketSelector: {
    asset: 'BTC',
    marketType: 'UP_DOWN',
    windowSec: 300,
  },
  agentProfile: {
    regimeAgentProfile: 'regime-default-v1',
    edgeAgentProfile: 'edge-momentum-v1',
    supervisorAgentProfile: 'supervisor-momentum-v1',
  },
  decisionPolicy: {
    allowedDecisions: ['TRADE_LONG', 'TRADE_SHORT', 'NO_TRADE'],
    minConfidence: 0.5,
  },
  filters: {
    maxSpreadBps: 300,
    minDepthScore: 0.4,
    minTimeToCloseSec: 10,
    maxTimeToCloseSec: 60,
  },
  riskProfile: {
    maxSizeUsd: 0.5,
    dailyLossLimitUsd: 10,
    maxTradesPerWindow: 2,
  },
  executionPolicy: {
    entryWindowStartSec: 60,
    entryWindowEndSec: 10,
    mode: 'paper',
  },
};

// ─── Volatility Fade Strategy (Wintermute / Market Maker style) ─────────────

const VOL_FADE_STRATEGY_KEY = 'btc-5m-vol-fade';

const VOL_FADE_STRATEGY_IDENTITY = {
  key: VOL_FADE_STRATEGY_KEY,
  name: 'BTC 5m Vol Fade',
  description:
    'Harvests volatility premium by buying underpriced tokens when implied vol exceeds realized vol.',
  status: 'active' as const,
  isDefault: false,
};

const VOL_FADE_VERSION_CONFIG: StrategyVersionConfig = {
  id: 'btc-5m-vol-fade-v1',
  label: 'BTC 5m Vol Fade v1',
  marketSelector: {
    asset: 'BTC',
    marketType: 'UP_DOWN',
    windowSec: 300,
  },
  agentProfile: {
    regimeAgentProfile: 'regime-default-v1',
    edgeAgentProfile: 'edge-vol-fade-v1',
    supervisorAgentProfile: 'supervisor-vol-fade-v1',
  },
  decisionPolicy: {
    allowedDecisions: ['TRADE_LONG', 'TRADE_SHORT', 'NO_TRADE'],
    minConfidence: 0.57,
  },
  filters: {
    maxSpreadBps: 300,
    minDepthScore: 0.3,
    minTimeToCloseSec: 60,
    maxTimeToCloseSec: 180,
    allowedRegimes: ['quiet', 'mean_reverting', 'volatile'],
  },
  riskProfile: {
    maxSizeUsd: 0.45,
    dailyLossLimitUsd: 10,
    maxTradesPerWindow: 1,
  },
  executionPolicy: {
    entryWindowStartSec: 180,
    entryWindowEndSec: 60,
    mode: 'paper',
  },
};

// ─── Liquidity Sweep Strategy ──────────────────────────────────────────────

const SWEEP_STRATEGY_KEY = 'btc-5m-sweep';

const SWEEP_STRATEGY_IDENTITY = {
  key: SWEEP_STRATEGY_KEY,
  name: 'BTC 5m Liquidity Sweep',
  description:
    'Detects stop-hunt sweeps beyond swing highs/lows and trades the reversal, amplified by Poly lag and volume spikes.',
  status: 'active' as const,
  isDefault: false,
};

const SWEEP_VERSION_CONFIG: StrategyVersionConfig = {
  id: 'btc-5m-sweep-v1',
  label: 'BTC 5m Liquidity Sweep v1',
  marketSelector: {
    asset: 'BTC',
    marketType: 'UP_DOWN',
    windowSec: 300,
  },
  agentProfile: {
    regimeAgentProfile: 'regime-default-v1',
    edgeAgentProfile: 'edge-sweep-v1',
    supervisorAgentProfile: 'supervisor-momentum-v1',
  },
  decisionPolicy: {
    allowedDecisions: ['TRADE_LONG', 'TRADE_SHORT', 'NO_TRADE'],
    minConfidence: 0.58,
  },
  filters: {
    maxSpreadBps: 400,
    minDepthScore: 0.25,
    minTimeToCloseSec: 60,
    maxTimeToCloseSec: 240,
    allowedRegimes: ['trending_up', 'trending_down', 'volatile', 'mean_reverting'],
  },
  riskProfile: {
    maxSizeUsd: 0.4,
    dailyLossLimitUsd: 10,
    maxTradesPerWindow: 1,
  },
  executionPolicy: {
    entryWindowStartSec: 240,
    entryWindowEndSec: 60,
    mode: 'paper',
  },
};

// ─── AMD (Accumulation-Manipulation-Distribution) Strategy ─────────────────

const AMD_STRATEGY_KEY = 'btc-5m-amd';

const AMD_STRATEGY_IDENTITY = {
  key: AMD_STRATEGY_KEY,
  name: 'BTC 5m AMD',
  description:
    'Identifies Accumulation-Manipulation-Distribution cycles — trades the Distribution reversal after a manipulation sweep/fake-out.',
  status: 'active' as const,
  isDefault: false,
};

const AMD_VERSION_CONFIG: StrategyVersionConfig = {
  id: 'btc-5m-amd-v1',
  label: 'BTC 5m AMD v1',
  marketSelector: {
    asset: 'BTC',
    marketType: 'UP_DOWN',
    windowSec: 300,
  },
  agentProfile: {
    regimeAgentProfile: 'regime-default-v1',
    edgeAgentProfile: 'edge-amd-v1',
    supervisorAgentProfile: 'supervisor-amd-v1',
  },
  decisionPolicy: {
    allowedDecisions: ['TRADE_LONG', 'TRADE_SHORT', 'NO_TRADE'],
    minConfidence: 0.60,
  },
  filters: {
    maxSpreadBps: 350,
    minDepthScore: 0.30,
    minTimeToCloseSec: 60,
    maxTimeToCloseSec: 210,
    allowedRegimes: ['trending_up', 'trending_down', 'volatile', 'mean_reverting'],
  },
  riskProfile: {
    maxSizeUsd: 0.45,
    dailyLossLimitUsd: 10,
    maxTradesPerWindow: 1,
  },
  executionPolicy: {
    entryWindowStartSec: 210,
    entryWindowEndSec: 60,
    mode: 'paper',
  },
};

// ─── All Additional Strategies ──────────────────────────────────────────────

const ADDITIONAL_STRATEGIES = [
  { key: MEAN_REVERSION_STRATEGY_KEY, identity: MEAN_REVERSION_STRATEGY_IDENTITY, config: MEAN_REVERSION_VERSION_CONFIG, active: true },
  { key: BASIS_ARB_STRATEGY_KEY, identity: BASIS_ARB_STRATEGY_IDENTITY, config: BASIS_ARB_VERSION_CONFIG, active: false },
  { key: VOL_FADE_STRATEGY_KEY, identity: VOL_FADE_STRATEGY_IDENTITY, config: VOL_FADE_VERSION_CONFIG, active: true },
  { key: SWEEP_STRATEGY_KEY, identity: SWEEP_STRATEGY_IDENTITY, config: SWEEP_VERSION_CONFIG, active: true },
  { key: AMD_STRATEGY_KEY, identity: AMD_STRATEGY_IDENTITY, config: AMD_VERSION_CONFIG, active: true },
];

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

  // 5. Seed additional strategies (mean-reversion, basis-arb, vol-fade)
  for (const { key, identity, config, active } of ADDITIONAL_STRATEGIES) {
    validateStrategyVersionConfig(config);

    // Upsert strategy identity
    const existingStrat = await db
      .select()
      .from(strategies)
      .where(eq(strategies.key, key))
      .limit(1);

    let stratId: string;
    if (existingStrat.length > 0) {
      stratId = existingStrat[0]!.id;
      console.log(`  Strategy already exists: ${identity.name} (${stratId})`);
    } else {
      const [inserted] = await db
        .insert(strategies)
        .values(identity)
        .returning({ id: strategies.id });
      stratId = inserted!.id;
      console.log(`  Created strategy: ${identity.name} (${stratId})`);
    }

    // Upsert version
    const existingVer = await db
      .select()
      .from(strategyVersions)
      .where(eq(strategyVersions.strategyId, stratId))
      .limit(1);

    let verIdAdditional: string;
    if (existingVer.length > 0 && existingVer[0]!.version === 1) {
      verIdAdditional = existingVer[0]!.id;
      console.log(`  Strategy version v1 already exists: ${identity.name} (${verIdAdditional})`);
    } else {
      const cksum = computeChecksum(config as unknown as Record<string, unknown>);
      const [inserted] = await db
        .insert(strategyVersions)
        .values({
          strategyId: stratId,
          version: 1,
          configJson: config as unknown as Record<string, unknown>,
          checksum: cksum,
        })
        .returning({ id: strategyVersions.id });
      verIdAdditional = inserted!.id;
      console.log(`  Created strategy version v1: ${identity.name} (${verIdAdditional})`);
    }

    // Upsert assignment
    const shouldBeActive = active ?? false;
    const existingAssign = await db
      .select()
      .from(strategyAssignments)
      .where(eq(strategyAssignments.strategyVersionId, verIdAdditional))
      .limit(1);

    if (existingAssign.length > 0) {
      console.log(`  Assignment already exists: ${identity.name} (${existingAssign[0]!.id})`);
    } else {
      const [inserted] = await db
        .insert(strategyAssignments)
        .values({
          marketConfigId,
          strategyVersionId: verIdAdditional,
          priority: 1,
          isActive: shouldBeActive,
        })
        .returning({ id: strategyAssignments.id });
      console.log(`  Created assignment (${shouldBeActive ? 'active' : 'inactive'}): ${identity.name} (${inserted!.id})`);
    }
  }

  console.log('\nSeed complete:');
  console.log(`  Market config: ${DEFAULT_MARKET_CONFIG.label} (${marketConfigId})`);
  console.log(`  Strategy (default): ${DEFAULT_STRATEGY_IDENTITY.name} (${strategyId})`);
  console.log(`  Version: v1 (${versionId})`);
  console.log(`  Additional strategies: ${ADDITIONAL_STRATEGIES.map(s => s.identity.name).join(', ')}`);
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
