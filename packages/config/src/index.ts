import { DynamicModule, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { z } from 'zod';
import type { ExecutionMode } from '@brain/types';

// ─── Config Schemas ─────────────────────────────────────────────────────────

export const AppConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'staging', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  EXECUTION_MODE: z.enum(['disabled', 'paper', 'live']).default('disabled'),
});

export const DatabaseConfigSchema = z.object({
  DATABASE_HOST: z.string().min(1).default('localhost'),
  DATABASE_PORT: z.coerce.number().int().min(1).max(65535).default(5432),
  DATABASE_USER: z.string().min(1).default('postgres'),
  DATABASE_PASSWORD: z.string().min(1).default('postgres'),
  DATABASE_NAME: z.string().min(1).default('brain'),
  DATABASE_SSL: z
    .string()
    .transform((v) => v === 'true')
    .default('false'),
  DATABASE_POOL_SIZE: z.coerce.number().int().min(1).max(100).default(10),
  DATABASE_URL: z.string().optional(),
});

export const PolymarketConfigSchema = z.object({
  POLYMARKET_API_URL: z.string().url().default('https://clob.polymarket.com'),
  POLYMARKET_WS_URL: z.string().url().default('wss://ws-subscriptions-clob.polymarket.com/ws'),
  POLYMARKET_API_KEY: z.string().optional(),
  POLYMARKET_API_SECRET: z.string().optional(),
  POLYMARKET_API_PASSPHRASE: z.string().optional(),
});

export const PriceFeedConfigSchema = z.object({
  BINANCE_WS_URL: z.string().url().default('wss://stream.binance.com:9443/ws'),
  COINBASE_WS_URL: z.string().url().default('wss://ws-feed.exchange.coinbase.com'),
  PRICE_FEED_SYMBOL: z.string().default('BTCUSDT'),
  PRICE_FEED_RECONNECT_MS: z.coerce.number().int().positive().default(5000),
  PRICE_FEED_MAX_RECONNECTS: z.coerce.number().int().positive().default(10),
});

export const AgentConfigSchema = z.object({
  AGENT_PROVIDER: z.enum(['anthropic', 'openai']).default('anthropic'),
  AGENT_MODEL: z.string().min(1).default('claude-sonnet-4-20250514'),
  AGENT_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  AGENT_MAX_RETRIES: z.coerce.number().int().nonnegative().default(2),
  AGENT_TEMPERATURE: z.coerce.number().min(0).max(2).default(0),
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
});

export const RiskConfigSchema = z.object({
  RISK_MAX_SIZE_USD: z.coerce.number().positive().default(50),
  RISK_DAILY_LOSS_LIMIT_USD: z.coerce.number().positive().default(200),
  RISK_MAX_SPREAD_BPS: z.coerce.number().positive().default(300),
  RISK_MIN_DEPTH_SCORE: z.coerce.number().nonnegative().default(0.1),
  RISK_MAX_TRADES_PER_WINDOW: z.coerce.number().int().positive().default(1),
});

const FullEnvSchema = AppConfigSchema.merge(DatabaseConfigSchema)
  .merge(PolymarketConfigSchema)
  .merge(PriceFeedConfigSchema)
  .merge(AgentConfigSchema)
  .merge(RiskConfigSchema);

type FullEnv = z.infer<typeof FullEnvSchema>;

// ─── Typed Config Accessors ─────────────────────────────────────────────────

export interface AppConfig {
  env: 'development' | 'staging' | 'production';
  port: number;
  mode: ExecutionMode;
}

export interface DatabaseConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  ssl: boolean;
  poolSize: number;
  connectionString: string;
}

export interface PolymarketConfig {
  apiUrl: string;
  wsUrl: string;
  apiKey?: string;
  apiSecret?: string;
  apiPassphrase?: string;
}

export interface PriceFeedConfig {
  binanceWsUrl: string;
  coinbaseWsUrl: string;
  symbol: string;
  reconnectIntervalMs: number;
  maxReconnectAttempts: number;
}

export interface AgentConfig {
  provider: 'anthropic' | 'openai';
  model: string;
  timeoutMs: number;
  maxRetries: number;
  temperature: number;
  anthropicApiKey?: string;
  openaiApiKey?: string;
}

export interface RiskConfigValues {
  maxSizeUsd: number;
  dailyLossLimitUsd: number;
  maxSpreadBps: number;
  minDepthScore: number;
  maxTradesPerWindow: number;
}

// ─── Config Factory Functions ───────────────────────────────────────────────

function buildAppConfig(env: FullEnv): AppConfig {
  return {
    env: env.NODE_ENV,
    port: env.PORT,
    mode: env.EXECUTION_MODE,
  };
}

function buildDatabaseConfig(env: FullEnv): DatabaseConfig {
  const connectionString =
    env.DATABASE_URL ??
    `postgresql://${env.DATABASE_USER}:${env.DATABASE_PASSWORD}@${env.DATABASE_HOST}:${env.DATABASE_PORT}/${env.DATABASE_NAME}${env.DATABASE_SSL ? '?sslmode=require' : ''}`;

  return {
    host: env.DATABASE_HOST,
    port: env.DATABASE_PORT,
    user: env.DATABASE_USER,
    password: env.DATABASE_PASSWORD,
    database: env.DATABASE_NAME,
    ssl: env.DATABASE_SSL,
    poolSize: env.DATABASE_POOL_SIZE,
    connectionString,
  };
}

function buildPolymarketConfig(env: FullEnv): PolymarketConfig {
  return {
    apiUrl: env.POLYMARKET_API_URL,
    wsUrl: env.POLYMARKET_WS_URL,
    apiKey: env.POLYMARKET_API_KEY,
    apiSecret: env.POLYMARKET_API_SECRET,
    apiPassphrase: env.POLYMARKET_API_PASSPHRASE,
  };
}

function buildPriceFeedConfig(env: FullEnv): PriceFeedConfig {
  return {
    binanceWsUrl: env.BINANCE_WS_URL,
    coinbaseWsUrl: env.COINBASE_WS_URL,
    symbol: env.PRICE_FEED_SYMBOL,
    reconnectIntervalMs: env.PRICE_FEED_RECONNECT_MS,
    maxReconnectAttempts: env.PRICE_FEED_MAX_RECONNECTS,
  };
}

function buildAgentConfig(env: FullEnv): AgentConfig {
  return {
    provider: env.AGENT_PROVIDER,
    model: env.AGENT_MODEL,
    timeoutMs: env.AGENT_TIMEOUT_MS,
    maxRetries: env.AGENT_MAX_RETRIES,
    temperature: env.AGENT_TEMPERATURE,
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    openaiApiKey: env.OPENAI_API_KEY,
  };
}

function buildRiskConfig(env: FullEnv): RiskConfigValues {
  return {
    maxSizeUsd: env.RISK_MAX_SIZE_USD,
    dailyLossLimitUsd: env.RISK_DAILY_LOSS_LIMIT_USD,
    maxSpreadBps: env.RISK_MAX_SPREAD_BPS,
    minDepthScore: env.RISK_MIN_DEPTH_SCORE,
    maxTradesPerWindow: env.RISK_MAX_TRADES_PER_WINDOW,
  };
}

// ─── Config Tokens ──────────────────────────────────────────────────────────

export const APP_CONFIG = 'APP_CONFIG';
export const DATABASE_CONFIG = 'DATABASE_CONFIG';
export const POLYMARKET_CONFIG = 'POLYMARKET_CONFIG';
export const PRICE_FEED_CONFIG = 'PRICE_FEED_CONFIG';
export const AGENT_CONFIG = 'AGENT_CONFIG';
export const RISK_CONFIG = 'RISK_CONFIG';

// ─── NestJS Module ──────────────────────────────────────────────────────────

@Module({})
export class BrainConfigModule {
  static forRoot(envFilePath?: string): DynamicModule {
    return {
      module: BrainConfigModule,
      global: true,
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          envFilePath: envFilePath ?? '.env',
          validate: (config: Record<string, unknown>) => {
            const result = FullEnvSchema.safeParse(config);
            if (!result.success) {
              const formatted = result.error.issues
                .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
                .join('\n');
              throw new Error(`Environment validation failed:\n${formatted}`);
            }
            return result.data;
          },
        }),
      ],
      providers: [
        {
          provide: APP_CONFIG,
          inject: [ConfigService],
          useFactory: (configService: ConfigService) => {
            const env = FullEnvSchema.parse(extractEnv(configService));
            return buildAppConfig(env);
          },
        },
        {
          provide: DATABASE_CONFIG,
          inject: [ConfigService],
          useFactory: (configService: ConfigService) => {
            const env = FullEnvSchema.parse(extractEnv(configService));
            return buildDatabaseConfig(env);
          },
        },
        {
          provide: POLYMARKET_CONFIG,
          inject: [ConfigService],
          useFactory: (configService: ConfigService) => {
            const env = FullEnvSchema.parse(extractEnv(configService));
            return buildPolymarketConfig(env);
          },
        },
        {
          provide: PRICE_FEED_CONFIG,
          inject: [ConfigService],
          useFactory: (configService: ConfigService) => {
            const env = FullEnvSchema.parse(extractEnv(configService));
            return buildPriceFeedConfig(env);
          },
        },
        {
          provide: AGENT_CONFIG,
          inject: [ConfigService],
          useFactory: (configService: ConfigService) => {
            const env = FullEnvSchema.parse(extractEnv(configService));
            return buildAgentConfig(env);
          },
        },
        {
          provide: RISK_CONFIG,
          inject: [ConfigService],
          useFactory: (configService: ConfigService) => {
            const env = FullEnvSchema.parse(extractEnv(configService));
            return buildRiskConfig(env);
          },
        },
      ],
      exports: [APP_CONFIG, DATABASE_CONFIG, POLYMARKET_CONFIG, PRICE_FEED_CONFIG, AGENT_CONFIG, RISK_CONFIG],
    };
  }
}

function extractEnv(configService: ConfigService): Record<string, unknown> {
  const keys = Object.keys(FullEnvSchema.shape);
  const env: Record<string, unknown> = {};
  for (const key of keys) {
    const value = configService.get(key);
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}
