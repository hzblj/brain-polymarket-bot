import {
  pgTable,
  uuid,
  text,
  timestamp,
  numeric,
  integer,
  boolean,
  jsonb,
  bigint,
  real,
} from 'drizzle-orm/pg-core';

// ─── Markets ─────────────────────────────────────────────────────────────────

export const markets = pgTable('markets', {
  id: uuid('id').primaryKey().defaultRandom(),
  conditionId: text('condition_id').notNull().unique(),
  slug: text('slug').notNull(),
  status: text('status', { enum: ['active', 'paused', 'resolved', 'expired'] })
    .notNull()
    .default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ─── Market Windows ─────────────────────────────────────────────────────────

export const marketWindows = pgTable('market_windows', {
  id: uuid('id').primaryKey().defaultRandom(),
  marketId: uuid('market_id')
    .notNull()
    .references(() => markets.id),
  startTime: bigint('start_time', { mode: 'number' }).notNull(),
  endTime: bigint('end_time', { mode: 'number' }).notNull(),
  startPrice: real('start_price').notNull(),
  outcome: text('outcome', { enum: ['up', 'down', 'flat', 'unknown'] })
    .notNull()
    .default('unknown'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ─── Price Ticks ─────────────────────────────────────────────────────────────

export const priceTicks = pgTable('price_ticks', {
  id: uuid('id').primaryKey().defaultRandom(),
  windowId: uuid('window_id')
    .notNull()
    .references(() => marketWindows.id),
  source: text('source', { enum: ['binance', 'coinbase', 'polymarket'] }).notNull(),
  price: numeric('price', { precision: 20, scale: 8 }).notNull(),
  bid: numeric('bid', { precision: 20, scale: 8 }).notNull(),
  ask: numeric('ask', { precision: 20, scale: 8 }).notNull(),
  eventTime: bigint('event_time', { mode: 'number' }).notNull(),
  ingestedAt: bigint('ingested_at', { mode: 'number' }).notNull(),
});

// ─── Book Snapshots ──────────────────────────────────────────────────────────

export const bookSnapshots = pgTable('book_snapshots', {
  id: uuid('id').primaryKey().defaultRandom(),
  windowId: uuid('window_id')
    .notNull()
    .references(() => marketWindows.id),
  upBid: real('up_bid').notNull(),
  upAsk: real('up_ask').notNull(),
  downBid: real('down_bid').notNull(),
  downAsk: real('down_ask').notNull(),
  spreadBps: real('spread_bps').notNull(),
  depthScore: real('depth_score').notNull(),
  imbalance: real('imbalance').notNull(),
  eventTime: bigint('event_time', { mode: 'number' }).notNull(),
  ingestedAt: bigint('ingested_at', { mode: 'number' }).notNull(),
});

// ─── Feature Snapshots ───────────────────────────────────────────────────────

export const featureSnapshots = pgTable('feature_snapshots', {
  id: uuid('id').primaryKey().defaultRandom(),
  windowId: uuid('window_id')
    .notNull()
    .references(() => marketWindows.id),
  payload: jsonb('payload').notNull(),
  eventTime: bigint('event_time', { mode: 'number' }).notNull(),
  processedAt: bigint('processed_at', { mode: 'number' }).notNull(),
});

// ─── Agent Decisions ─────────────────────────────────────────────────────────

export const agentDecisions = pgTable('agent_decisions', {
  id: uuid('id').primaryKey().defaultRandom(),
  windowId: uuid('window_id')
    .notNull()
    .references(() => marketWindows.id),
  agentType: text('agent_type', { enum: ['regime', 'edge', 'supervisor'] }).notNull(),
  input: jsonb('input').notNull(),
  output: jsonb('output').notNull(),
  model: text('model').notNull(),
  provider: text('provider').notNull(),
  latencyMs: integer('latency_ms').notNull(),
  eventTime: bigint('event_time', { mode: 'number' }).notNull(),
  processedAt: bigint('processed_at', { mode: 'number' }).notNull(),
});

// ─── Risk Decisions ──────────────────────────────────────────────────────────

export const riskDecisions = pgTable('risk_decisions', {
  id: uuid('id').primaryKey().defaultRandom(),
  windowId: uuid('window_id')
    .notNull()
    .references(() => marketWindows.id),
  agentDecisionId: uuid('agent_decision_id')
    .notNull()
    .references(() => agentDecisions.id),
  approved: boolean('approved').notNull(),
  approvedSizeUsd: real('approved_size_usd').notNull().default(0),
  rejectionReasons: jsonb('rejection_reasons').notNull().default([]),
  eventTime: bigint('event_time', { mode: 'number' }).notNull(),
  processedAt: bigint('processed_at', { mode: 'number' }).notNull(),
});

// ─── Orders ──────────────────────────────────────────────────────────────────

export const orders = pgTable('orders', {
  id: uuid('id').primaryKey().defaultRandom(),
  windowId: uuid('window_id')
    .notNull()
    .references(() => marketWindows.id),
  riskDecisionId: uuid('risk_decision_id')
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
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ─── Fills ───────────────────────────────────────────────────────────────────

export const fills = pgTable('fills', {
  id: uuid('id').primaryKey().defaultRandom(),
  orderId: uuid('order_id')
    .notNull()
    .references(() => orders.id),
  fillPrice: real('fill_price').notNull(),
  fillSizeUsd: real('fill_size_usd').notNull(),
  filledAt: timestamp('filled_at', { withTimezone: true }).notNull().defaultNow(),
});

// ─── Replays ─────────────────────────────────────────────────────────────────

export const replays = pgTable('replays', {
  id: uuid('id').primaryKey().defaultRandom(),
  fromTime: bigint('from_time', { mode: 'number' }).notNull(),
  toTime: bigint('to_time', { mode: 'number' }).notNull(),
  config: jsonb('config').notNull(),
  results: jsonb('results'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ─── Service Health Logs ─────────────────────────────────────────────────────

export const serviceHealthLogs = pgTable('service_health_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  service: text('service').notNull(),
  status: text('status', { enum: ['healthy', 'degraded', 'unhealthy'] }).notNull(),
  details: jsonb('details').notNull().default({}),
  checkedAt: timestamp('checked_at', { withTimezone: true }).notNull().defaultNow(),
});
