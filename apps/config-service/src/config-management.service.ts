import { createHash } from 'node:crypto';
import {
  DATABASE_CLIENT,
  type DbClient,
  marketConfigs,
  strategies,
  strategyAssignments,
  strategyVersions,
  systemConfigs,
} from '@brain/database';
import { EventBus } from '@brain/events';
import type { ExecutionMode } from '@brain/types';
import { HttpException, HttpStatus, Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';

// ─── Zod Schemas for Config Validation ───────────────────────────────────────

const TradingConfigSchema = z.object({
  edgeThresholdMin: z.number().min(0).max(1).optional(),
  edgeThresholdStrong: z.number().min(0).max(1).optional(),
  maxSpreadBps: z.number().positive().optional(),
  minDepthScore: z.number().nonnegative().optional(),
  maxSizeUsd: z.number().positive().optional(),
  mode: z.enum(['disabled', 'paper', 'live']).optional(),
});

const RiskConfigSchema = z.object({
  dailyLossLimitUsd: z.number().positive().optional(),
  maxTradesPerWindow: z.number().int().positive().optional(),
  maxSizeUsd: z.number().positive().optional(),
  maxSpreadBps: z.number().positive().optional(),
  minDepthScore: z.number().nonnegative().optional(),
});

const ProviderConfigSchema = z.object({
  provider: z.enum(['anthropic', 'openai']).optional(),
  model: z.string().min(1).optional(),
  temperature: z.number().min(0).max(2).optional(),
  timeoutMs: z.number().int().positive().optional(),
  maxRetries: z.number().int().nonnegative().optional(),
});

const FeatureFlagSchema = z.object({
  agentRegimeEnabled: z.boolean().optional(),
  agentEdgeEnabled: z.boolean().optional(),
  agentSupervisorEnabled: z.boolean().optional(),
  liveExecutionEnabled: z.boolean().optional(),
  replayEnabled: z.boolean().optional(),
  metricsEnabled: z.boolean().optional(),
});

const MarketResolverSchema = z.object({
  type: z.enum(['CHAINLINK_PROXY', 'EXTERNAL_PROXY']).optional(),
  symbol: z.string().min(1).optional(),
});

const MarketConfigUpdateSchema = z.object({
  label: z.string().min(1).optional(),
  asset: z.string().min(1).optional(),
  marketType: z.enum(['UP_DOWN']).optional(),
  windowSec: z.number().int().positive().optional(),
  defaultEnabled: z.boolean().optional(),
  resolver: MarketResolverSchema.optional(),
});

const SystemConfigUpdateSchema = z.object({
  trading: TradingConfigSchema.optional(),
  risk: RiskConfigSchema.optional(),
  provider: ProviderConfigSchema.optional(),
  featureFlags: FeatureFlagSchema.optional(),
});

export type SystemConfigUpdate = z.infer<typeof SystemConfigUpdateSchema>;

// ─── Config Shape ────────────────────────────────────────────────────────────

interface TradingConfig {
  edgeThresholdMin: number;
  edgeThresholdStrong: number;
  maxSpreadBps: number;
  minDepthScore: number;
  maxSizeUsd: number;
  mode: ExecutionMode;
}

interface RiskConfig {
  dailyLossLimitUsd: number;
  maxTradesPerWindow: number;
  maxSizeUsd: number;
  maxSpreadBps: number;
  minDepthScore: number;
}

interface ProviderConfig {
  provider: 'anthropic' | 'openai';
  model: string;
  temperature: number;
  timeoutMs: number;
  maxRetries: number;
}

interface FeatureFlags {
  agentRegimeEnabled: boolean;
  agentEdgeEnabled: boolean;
  agentSupervisorEnabled: boolean;
  liveExecutionEnabled: boolean;
  replayEnabled: boolean;
  metricsEnabled: boolean;
}

interface MarketConfig {
  id: string;
  label: string;
  asset: string;
  marketType: 'UP_DOWN';
  windowSec: number;
  defaultEnabled: boolean;
  resolver: {
    type: 'CHAINLINK_PROXY' | 'EXTERNAL_PROXY';
    symbol: string;
  };
}

interface EffectiveConfig {
  market: MarketConfig;
  trading: TradingConfig;
  risk: RiskConfig;
  provider: ProviderConfig;
  featureFlags: FeatureFlags;
  updatedAt: string;
  source: 'database' | 'defaults';
}

// ─── Defaults ────────────────────────────────────────────────────────────────

const DEFAULT_TRADING: TradingConfig = {
  edgeThresholdMin: 0.05,
  edgeThresholdStrong: 0.15,
  maxSpreadBps: 300,
  minDepthScore: 0.1,
  maxSizeUsd: 0.5,
  mode: 'disabled',
};

const DEFAULT_RISK: RiskConfig = {
  dailyLossLimitUsd: 10,
  maxTradesPerWindow: 1,
  maxSizeUsd: 0.5,
  maxSpreadBps: 300,
  minDepthScore: 0.1,
};

const DEFAULT_PROVIDER: ProviderConfig = {
  provider: 'anthropic',
  model: 'claude-sonnet-4-20250514',
  temperature: 0,
  timeoutMs: 30_000,
  maxRetries: 2,
};

const DEFAULT_MARKET: MarketConfig = {
  id: 'bitcoin-5m-default',
  label: 'bitcoin-5m',
  asset: 'BTC',
  marketType: 'UP_DOWN',
  windowSec: 300,
  defaultEnabled: true,
  resolver: {
    type: 'CHAINLINK_PROXY',
    symbol: 'BTC/USD',
  },
};

const DEFAULT_FLAGS: FeatureFlags = {
  agentRegimeEnabled: true,
  agentEdgeEnabled: true,
  agentSupervisorEnabled: true,
  liveExecutionEnabled: false,
  replayEnabled: true,
  metricsEnabled: true,
};

@Injectable()
export class ConfigManagementService implements OnModuleInit {
  private readonly logger = new Logger(ConfigManagementService.name);
  private market: MarketConfig = { ...DEFAULT_MARKET, resolver: { ...DEFAULT_MARKET.resolver } };
  private trading: TradingConfig = { ...DEFAULT_TRADING };
  private risk: RiskConfig = { ...DEFAULT_RISK };
  private provider: ProviderConfig = { ...DEFAULT_PROVIDER };
  private featureFlags: FeatureFlags = { ...DEFAULT_FLAGS };
  private lastUpdatedAt: string = new Date().toISOString();
  private configSource: 'database' | 'defaults' = 'defaults';

  constructor(
    @Inject(DATABASE_CLIENT) private readonly db: DbClient,
    private readonly eventBus: EventBus,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.autoSeedIfEmpty();
    await this.loadFromDatabase();
    this.applyEnvOverrides();
  }

  /**
   * If the strategies table is empty, seed default market config,
   * strategy, version, and assignment inline.
   */
  private async autoSeedIfEmpty(): Promise<void> {
    try {
      const rows = await this.db.select().from(strategies).limit(1);
      if (rows.length > 0) return;

      this.logger.log('Empty database detected — running auto-seed...');

      // 1. Market config
      const existingMC = await this.db
        .select()
        .from(marketConfigs)
        .where(eq(marketConfigs.label, 'Bitcoin 5m Up/Down'))
        .limit(1);

      let mcId: string;
      if (existingMC.length > 0) {
        mcId = existingMC[0]!.id;
      } else {
        const [ins] = await this.db
          .insert(marketConfigs)
          .values({
            label: 'Bitcoin 5m Up/Down',
            asset: 'BTC',
            marketType: 'UP_DOWN',
            windowSec: 300,
            resolverType: 'polymarket',
            resolverSymbol: 'BTCUSDT',
            defaultEnabled: true,
            isActive: true,
          })
          .returning({ id: marketConfigs.id });
        mcId = ins!.id;
      }

      // 2. Strategy
      const [strat] = await this.db
        .insert(strategies)
        .values({
          key: 'btc-5m-momentum',
          name: 'BTC 5m Momentum',
          description: 'Default conservative momentum strategy for Bitcoin 5-minute Up/Down markets.',
          status: 'active',
          isDefault: true,
        })
        .returning({ id: strategies.id });
      const stratId = strat!.id;

      // 3. Strategy version
      const versionConfig = {
        id: 'btc-5m-momentum-v1',
        label: 'BTC 5m Momentum v1',
        marketSelector: { asset: 'BTC', marketType: 'UP_DOWN', windowSec: 300 },
        agentProfile: {
          regimeAgentProfile: 'regime-default-v1',
          edgeAgentProfile: 'edge-momentum-v1',
          supervisorAgentProfile: 'supervisor-conservative-v1',
        },
        decisionPolicy: { allowedDecisions: ['TRADE_LONG', 'TRADE_SHORT', 'NO_TRADE'], minConfidence: 0.7 },
        filters: { maxSpreadBps: 250, minDepthScore: 0.6, minTimeToCloseSec: 15, maxTimeToCloseSec: 90 },
        riskProfile: { maxSizeUsd: 0.5, dailyLossLimitUsd: 10, maxTradesPerWindow: 1 },
        executionPolicy: { entryWindowStartSec: 90, entryWindowEndSec: 10, mode: 'paper' },
      };
      const checksum = createHash('sha256').update(JSON.stringify(versionConfig)).digest('hex');

      const [ver] = await this.db
        .insert(strategyVersions)
        .values({
          strategyId: stratId,
          version: 1,
          configJson: versionConfig as unknown as Record<string, unknown>,
          checksum,
        })
        .returning({ id: strategyVersions.id });

      // 4. Assignment
      await this.db.insert(strategyAssignments).values({
        marketConfigId: mcId,
        strategyVersionId: ver!.id,
        priority: 0,
        isActive: true,
      });

      this.logger.log('Auto-seed complete');
    } catch (error) {
      this.logger.warn(`Auto-seed failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ─── Public API ──────────────────────────────────────────────────────────────

  /**
   * Returns the full effective config: DB values merged over env overrides over defaults.
   */
  getEffectiveConfig(): EffectiveConfig {
    return {
      market: { ...this.market, resolver: { ...this.market.resolver } },
      trading: { ...this.trading },
      risk: { ...this.risk },
      provider: { ...this.provider },
      featureFlags: { ...this.featureFlags },
      updatedAt: this.lastUpdatedAt,
      source: this.configSource,
    };
  }

  /**
   * Updates system configuration. Validates with Zod before applying.
   */
  async updateConfig(update: SystemConfigUpdate): Promise<EffectiveConfig> {
    // Validate the incoming update
    const parsed = SystemConfigUpdateSchema.safeParse(update);
    if (!parsed.success) {
      throw new HttpException(
        {
          message: 'Invalid config update',
          errors: parsed.error.issues.map((i) => ({
            path: i.path.join('.'),
            message: i.message,
          })),
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    const data = parsed.data;

    // Merge trading config
    if (data.trading) {
      this.trading = { ...this.trading, ...this.stripUndefined(data.trading) };
    }

    // Merge risk config
    if (data.risk) {
      this.risk = { ...this.risk, ...this.stripUndefined(data.risk) };
    }

    // Merge provider config
    if (data.provider) {
      this.provider = { ...this.provider, ...this.stripUndefined(data.provider) };
    }

    // Merge feature flags
    if (data.featureFlags) {
      this.featureFlags = { ...this.featureFlags, ...this.stripUndefined(data.featureFlags) };
    }

    this.lastUpdatedAt = new Date().toISOString();
    this.configSource = 'database';

    // Persist to database
    await this.persistToDatabase();

    // Emit config changed event
    this.emitEvent('config.updated', {
      trading: this.trading,
      risk: this.risk,
      provider: this.provider,
      featureFlags: this.featureFlags,
    });

    return this.getEffectiveConfig();
  }

  /**
   * Returns the current market configuration.
   */
  getMarketConfig(): MarketConfig {
    return { ...this.market };
  }

  /**
   * Updates the market configuration. Validates with Zod before applying.
   */
  async updateMarketConfig(update: Record<string, unknown>): Promise<MarketConfig> {
    const parsed = MarketConfigUpdateSchema.safeParse(update);
    if (!parsed.success) {
      throw new HttpException(
        {
          message: 'Invalid market config update',
          errors: parsed.error.issues.map((i) => ({
            path: i.path.join('.'),
            message: i.message,
          })),
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    const { resolver, ...rest } = parsed.data;
    this.market = { ...this.market, ...this.stripUndefined(rest) };
    if (resolver) {
      this.market.resolver = { ...this.market.resolver, ...this.stripUndefined(resolver) };
    }
    this.lastUpdatedAt = new Date().toISOString();
    this.configSource = 'database';

    await this.persistToDatabase();
    this.emitEvent('config.market.updated', { market: this.market });

    return this.getMarketConfig();
  }

  /**
   * Resets all runtime config to default Bitcoin 5m preset.
   */
  async resetDefaults(): Promise<EffectiveConfig> {
    this.trading = { ...DEFAULT_TRADING };
    this.risk = { ...DEFAULT_RISK };
    this.provider = { ...DEFAULT_PROVIDER };
    this.featureFlags = { ...DEFAULT_FLAGS };
    this.market = { ...DEFAULT_MARKET };
    this.lastUpdatedAt = new Date().toISOString();
    this.configSource = 'defaults';

    await this.persistToDatabase();
    this.emitEvent('config.reset', {});

    return this.getEffectiveConfig();
  }

  /**
   * Returns current feature flags.
   */
  getFeatureFlags(): FeatureFlags {
    return { ...this.featureFlags };
  }

  // ─── Internal Helpers ──────────────────────────────────────────────────────

  private async loadFromDatabase(): Promise<void> {
    try {
      const rows = await this.db
        .select()
        .from(systemConfigs)
        .orderBy(desc(systemConfigs.updatedAt))
        .limit(1);
      if (rows.length > 0) {
        const stored = rows[0]?.config as Record<string, unknown>;
        if (stored.market) {
          const m = stored.market as Partial<MarketConfig>;
          this.market = { ...this.market, ...m, resolver: { ...this.market.resolver, ...(m.resolver ?? {}) } };
        }
        if (stored.trading)
          this.trading = { ...this.trading, ...(stored.trading as Partial<TradingConfig>) };
        if (stored.risk) this.risk = { ...this.risk, ...(stored.risk as Partial<RiskConfig>) };
        if (stored.provider)
          this.provider = { ...this.provider, ...(stored.provider as Partial<ProviderConfig>) };
        if (stored.featureFlags)
          this.featureFlags = {
            ...this.featureFlags,
            ...(stored.featureFlags as Partial<FeatureFlags>),
          };
        this.configSource = 'database';
        this.lastUpdatedAt = rows[0]?.updatedAt ?? new Date().toISOString();
      } else {
        // no stored config found, use defaults
      }
    } catch (_error) {
      /* ignored - fall back to defaults */
    }
  }

  private applyEnvOverrides(): void {
    // Allow environment variables to override defaults (before DB values)
    const env = process.env;

    if (env.EXECUTION_MODE) {
      const mode = env.EXECUTION_MODE as ExecutionMode;
      if (['disabled', 'paper', 'live'].includes(mode)) {
        this.trading.mode = mode;
      }
    }
    if (env.RISK_MAX_SIZE_USD) {
      this.risk.maxSizeUsd = parseFloat(env.RISK_MAX_SIZE_USD);
      this.trading.maxSizeUsd = parseFloat(env.RISK_MAX_SIZE_USD);
    }
    if (env.RISK_DAILY_LOSS_LIMIT_USD) {
      this.risk.dailyLossLimitUsd = parseFloat(env.RISK_DAILY_LOSS_LIMIT_USD);
    }
    if (env.AGENT_PROVIDER) {
      this.provider.provider = env.AGENT_PROVIDER as 'anthropic' | 'openai';
    }
    if (env.AGENT_MODEL) {
      this.provider.model = env.AGENT_MODEL;
    }
  }

  private async persistToDatabase(): Promise<void> {
    try {
      await this.db.insert(systemConfigs).values({
        config: {
          market: this.market,
          trading: this.trading,
          risk: this.risk,
          provider: this.provider,
          featureFlags: this.featureFlags,
        },
        updatedAt: this.lastUpdatedAt,
      });
    } catch (_error) {
      /* ignored - persistence is best-effort */
    }
  }

  private stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
    const result: Partial<T> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (value !== undefined) {
        (result as Record<string, unknown>)[key] = value;
      }
    }
    return result;
  }

  private emitEvent(event: string, payload: Record<string, unknown>): void {
    this.eventBus.emit(event as any, payload);
  }
}
