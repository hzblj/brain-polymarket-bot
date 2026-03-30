import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// ─── Markets ─────────────────────────────────────────────────────────────────

export const markets = sqliteTable('markets', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  conditionId: text('condition_id').notNull().unique(),
  slug: text('slug').notNull(),
  status: text('status', { enum: ['active', 'paused', 'resolved', 'expired'] })
    .notNull()
    .default('active'),
  createdAt: text('created_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

// ─── Market Windows ─────────────────────────────────────────────────────────

export const marketWindows = sqliteTable('market_windows', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  marketId: text('market_id')
    .notNull()
    .references(() => markets.id),
  startTime: integer('start_time').notNull(),
  endTime: integer('end_time').notNull(),
  startPrice: real('start_price').notNull(),
  outcome: text('outcome', { enum: ['up', 'down', 'flat', 'unknown'] })
    .notNull()
    .default('unknown'),
  createdAt: text('created_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

// ─── Price Ticks ─────────────────────────────────────────────────────────────

export const priceTicks = sqliteTable('price_ticks', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  windowId: text('window_id')
    .notNull()
    .references(() => marketWindows.id),
  source: text('source', { enum: ['binance', 'coinbase', 'polymarket'] }).notNull(),
  price: real('price').notNull(),
  bid: real('bid').notNull(),
  ask: real('ask').notNull(),
  eventTime: integer('event_time').notNull(),
  ingestedAt: integer('ingested_at').notNull(),
});

// ─── Book Snapshots ──────────────────────────────────────────────────────────

export const bookSnapshots = sqliteTable('book_snapshots', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  windowId: text('window_id')
    .notNull()
    .references(() => marketWindows.id),
  upBid: real('up_bid').notNull(),
  upAsk: real('up_ask').notNull(),
  downBid: real('down_bid').notNull(),
  downAsk: real('down_ask').notNull(),
  spreadBps: real('spread_bps').notNull(),
  depthScore: real('depth_score').notNull(),
  imbalance: real('imbalance').notNull(),
  eventTime: integer('event_time').notNull(),
  ingestedAt: integer('ingested_at').notNull(),
});

// ─── Feature Snapshots ───────────────────────────────────────────────────────

export const featureSnapshots = sqliteTable('feature_snapshots', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  windowId: text('window_id')
    .notNull()
    .references(() => marketWindows.id),
  payload: text('payload', { mode: 'json' }).notNull(),
  eventTime: integer('event_time').notNull(),
  processedAt: integer('processed_at').notNull(),
});

// ─── Agent Decisions ─────────────────────────────────────────────────────────

export const agentDecisions = sqliteTable('agent_decisions', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  windowId: text('window_id')
    .notNull()
    .references(() => marketWindows.id),
  agentType: text('agent_type', { enum: ['regime', 'edge', 'supervisor'] }).notNull(),
  input: text('input', { mode: 'json' }).notNull(),
  output: text('output', { mode: 'json' }).notNull(),
  model: text('model').notNull(),
  provider: text('provider').notNull(),
  latencyMs: integer('latency_ms').notNull(),
  eventTime: integer('event_time').notNull(),
  processedAt: integer('processed_at').notNull(),
});

// ─── Risk Decisions ──────────────────────────────────────────────────────────

export const riskDecisions = sqliteTable('risk_decisions', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  windowId: text('window_id')
    .notNull()
    .references(() => marketWindows.id),
  agentDecisionId: text('agent_decision_id')
    .notNull()
    .references(() => agentDecisions.id),
  approved: integer('approved', { mode: 'boolean' }).notNull(),
  approvedSizeUsd: real('approved_size_usd').notNull().default(0),
  rejectionReasons: text('rejection_reasons', { mode: 'json' }).notNull().$type<string[]>(),
  eventTime: integer('event_time').notNull(),
  processedAt: integer('processed_at').notNull(),
});

// ─── Orders ──────────────────────────────────────────────────────────────────

export const orders = sqliteTable('orders', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  windowId: text('window_id')
    .notNull()
    .references(() => marketWindows.id),
  riskDecisionId: text('risk_decision_id')
    .notNull()
    .references(() => riskDecisions.id),
  side: text('side', { enum: ['buy_up', 'buy_down'] }).notNull(),
  mode: text('mode', { enum: ['disabled', 'paper', 'live'] }).notNull(),
  sizeUsd: real('size_usd').notNull(),
  entryPrice: real('entry_price').notNull(),
  status: text('status', {
    enum: ['pending', 'placed', 'partial', 'filled', 'cancelled', 'failed'],
  })
    .notNull()
    .default('pending'),
  polymarketOrderId: text('polymarket_order_id'),
  createdAt: text('created_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
  updatedAt: text('updated_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

// ─── Fills ───────────────────────────────────────────────────────────────────

export const fills = sqliteTable('fills', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  orderId: text('order_id')
    .notNull()
    .references(() => orders.id),
  fillPrice: real('fill_price').notNull(),
  fillSizeUsd: real('fill_size_usd').notNull(),
  filledAt: text('filled_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

// ─── Replays ─────────────────────────────────────────────────────────────────

export const replays = sqliteTable('replays', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  fromTime: integer('from_time').notNull(),
  toTime: integer('to_time').notNull(),
  config: text('config', { mode: 'json' }).notNull(),
  results: text('results', { mode: 'json' }),
  createdAt: text('created_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

// ─── Service Health Logs ─────────────────────────────────────────────────────

export const serviceHealthLogs = sqliteTable('service_health_logs', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  service: text('service').notNull(),
  status: text('status', { enum: ['healthy', 'degraded', 'unhealthy'] }).notNull(),
  details: text('details', { mode: 'json' }).notNull().$type<Record<string, unknown>>(),
  checkedAt: text('checked_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

// ─── System Configs ──────────────────────────────────────────────────────────

export const systemConfigs = sqliteTable('system_configs', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  config: text('config', { mode: 'json' }).notNull().$type<Record<string, unknown>>(),
  updatedAt: text('updated_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

// ─── Risk Configs ────────────────────────────────────────────────────────────

export const riskConfigs = sqliteTable('risk_configs', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  config: text('config', { mode: 'json' }).notNull().$type<Record<string, unknown>>(),
  killSwitchActive: integer('kill_switch_active', { mode: 'boolean' }).notNull().default(false),
  tradingEnabled: integer('trading_enabled', { mode: 'boolean' }).notNull().default(true),
  updatedAt: text('updated_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

// ─── Market Configs ─────────────────────────────────────────────────────────

export const marketConfigs = sqliteTable('market_configs', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  label: text('label').notNull(),
  asset: text('asset').notNull(),
  marketType: text('market_type').notNull(),
  windowSec: integer('window_sec').notNull(),
  resolverType: text('resolver_type').notNull(),
  resolverSymbol: text('resolver_symbol').notNull(),
  defaultEnabled: integer('default_enabled', { mode: 'boolean' }).notNull().default(true),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
  updatedAt: text('updated_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

// ─── Strategies ─────────────────────────────────────────────────────────────

export const strategies = sqliteTable('strategies', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  key: text('key').notNull().unique(),
  name: text('name').notNull(),
  description: text('description').notNull(),
  status: text('status', { enum: ['active', 'inactive', 'archived'] })
    .notNull()
    .default('active'),
  isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
  updatedAt: text('updated_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

// ─── Strategy Versions ──────────────────────────────────────────────────────

export const strategyVersions = sqliteTable('strategy_versions', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  strategyId: text('strategy_id')
    .notNull()
    .references(() => strategies.id),
  version: integer('version').notNull(),
  configJson: text('config_json', { mode: 'json' }).notNull().$type<Record<string, unknown>>(),
  checksum: text('checksum').notNull(),
  createdAt: text('created_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

// ─── Strategy Assignments ───────────────────────────────────────────────────

export const strategyAssignments = sqliteTable('strategy_assignments', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  marketConfigId: text('market_config_id')
    .notNull()
    .references(() => marketConfigs.id),
  strategyVersionId: text('strategy_version_id')
    .notNull()
    .references(() => strategyVersions.id),
  priority: integer('priority').notNull().default(0),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
  updatedAt: text('updated_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

// ─── Strategy Runs ──────────────────────────────────────────────────────────

export const strategyRuns = sqliteTable('strategy_runs', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  strategyVersionId: text('strategy_version_id')
    .notNull()
    .references(() => strategyVersions.id),
  marketConfigId: text('market_config_id')
    .notNull()
    .references(() => marketConfigs.id),
  decisionId: text('decision_id'),
  replayId: text('replay_id'),
  mode: text('mode', { enum: ['disabled', 'paper', 'live'] })
    .notNull()
    .default('paper'),
  createdAt: text('created_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});
