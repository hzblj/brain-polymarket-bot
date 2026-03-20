import { Injectable, OnModuleInit, HttpException, HttpStatus } from '@nestjs/common';
import { z } from 'zod';
import type { ExecutionMode } from '@brain/types';

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

interface EffectiveConfig {
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
  maxSizeUsd: 50,
  mode: 'disabled',
};

const DEFAULT_RISK: RiskConfig = {
  dailyLossLimitUsd: 200,
  maxTradesPerWindow: 1,
  maxSizeUsd: 50,
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
  private trading: TradingConfig = { ...DEFAULT_TRADING };
  private risk: RiskConfig = { ...DEFAULT_RISK };
  private provider: ProviderConfig = { ...DEFAULT_PROVIDER };
  private featureFlags: FeatureFlags = { ...DEFAULT_FLAGS };
  private lastUpdatedAt: string = new Date().toISOString();
  private configSource: 'database' | 'defaults' = 'defaults';

  // TODO: inject @brain/database, @brain/events, @brain/logger
  // constructor(
  //   private readonly database: DatabaseService,
  //   private readonly events: EventsService,
  //   private readonly logger: LoggerService,
  // ) {}

  async onModuleInit(): Promise<void> {
    await this.loadFromDatabase();
    this.applyEnvOverrides();
    console.log('[config-service] initialized, mode:', this.trading.mode);
  }

  // ─── Public API ──────────────────────────────────────────────────────────────

  /**
   * Returns the full effective config: DB values merged over env overrides over defaults.
   */
  async getEffectiveConfig(): Promise<EffectiveConfig> {
    return {
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

    console.log('[config-service] config updated at', this.lastUpdatedAt);

    return this.getEffectiveConfig();
  }

  /**
   * Returns current feature flags.
   */
  async getFeatureFlags(): Promise<FeatureFlags> {
    return { ...this.featureFlags };
  }

  // ─── Internal Helpers ──────────────────────────────────────────────────────

  private async loadFromDatabase(): Promise<void> {
    try {
      // TODO: Load from database
      // const stored = await this.database.systemConfig.findLatest();
      // if (stored) {
      //   this.trading = { ...this.trading, ...stored.trading };
      //   this.risk = { ...this.risk, ...stored.risk };
      //   this.provider = { ...this.provider, ...stored.provider };
      //   this.featureFlags = { ...this.featureFlags, ...stored.featureFlags };
      //   this.configSource = 'database';
      //   this.lastUpdatedAt = stored.updatedAt;
      // }
      console.log('[config-service] database load: using defaults (DB not wired yet)');
    } catch (error) {
      console.error('[config-service] Failed to load config from database, using defaults:', error);
    }
  }

  private applyEnvOverrides(): void {
    // Allow environment variables to override defaults (before DB values)
    const env = process.env;

    if (env['EXECUTION_MODE']) {
      const mode = env['EXECUTION_MODE'] as ExecutionMode;
      if (['disabled', 'paper', 'live'].includes(mode)) {
        this.trading.mode = mode;
      }
    }
    if (env['RISK_MAX_SIZE_USD']) {
      this.risk.maxSizeUsd = parseFloat(env['RISK_MAX_SIZE_USD']);
      this.trading.maxSizeUsd = parseFloat(env['RISK_MAX_SIZE_USD']);
    }
    if (env['RISK_DAILY_LOSS_LIMIT_USD']) {
      this.risk.dailyLossLimitUsd = parseFloat(env['RISK_DAILY_LOSS_LIMIT_USD']);
    }
    if (env['AGENT_PROVIDER']) {
      this.provider.provider = env['AGENT_PROVIDER'] as 'anthropic' | 'openai';
    }
    if (env['AGENT_MODEL']) {
      this.provider.model = env['AGENT_MODEL'];
    }
  }

  private async persistToDatabase(): Promise<void> {
    try {
      // TODO: Persist to database
      // await this.database.systemConfig.upsert({
      //   trading: this.trading,
      //   risk: this.risk,
      //   provider: this.provider,
      //   featureFlags: this.featureFlags,
      //   updatedAt: this.lastUpdatedAt,
      // });
    } catch (error) {
      console.error('[config-service] Failed to persist config to database:', error);
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
    // TODO: Wire to @brain/events
    // this.events.emit(event, payload);
    console.log(`[config-service] event: ${event}`);
  }
}
