import { relations } from 'drizzle-orm';
import {
  agentDecisions,
  bookSnapshots,
  featureSnapshots,
  fills,
  marketConfigs,
  markets,
  marketWindows,
  orders,
  priceTicks,
  riskDecisions,
  strategies,
  strategyAssignments,
  strategyRuns,
  strategyVersions,
} from './schema';

export const marketsRelations = relations(markets, ({ many }) => ({
  windows: many(marketWindows),
}));

export const marketWindowsRelations = relations(marketWindows, ({ one, many }) => ({
  market: one(markets, {
    fields: [marketWindows.marketId],
    references: [markets.id],
  }),
  priceTicks: many(priceTicks),
  bookSnapshots: many(bookSnapshots),
  featureSnapshots: many(featureSnapshots),
  agentDecisions: many(agentDecisions),
  riskDecisions: many(riskDecisions),
  orders: many(orders),
}));

export const priceTicksRelations = relations(priceTicks, ({ one }) => ({
  window: one(marketWindows, {
    fields: [priceTicks.windowId],
    references: [marketWindows.id],
  }),
}));

export const bookSnapshotsRelations = relations(bookSnapshots, ({ one }) => ({
  window: one(marketWindows, {
    fields: [bookSnapshots.windowId],
    references: [marketWindows.id],
  }),
}));

export const featureSnapshotsRelations = relations(featureSnapshots, ({ one }) => ({
  window: one(marketWindows, {
    fields: [featureSnapshots.windowId],
    references: [marketWindows.id],
  }),
}));

export const agentDecisionsRelations = relations(agentDecisions, ({ one, many }) => ({
  window: one(marketWindows, {
    fields: [agentDecisions.windowId],
    references: [marketWindows.id],
  }),
  riskDecisions: many(riskDecisions),
}));

export const riskDecisionsRelations = relations(riskDecisions, ({ one, many }) => ({
  window: one(marketWindows, {
    fields: [riskDecisions.windowId],
    references: [marketWindows.id],
  }),
  agentDecision: one(agentDecisions, {
    fields: [riskDecisions.agentDecisionId],
    references: [agentDecisions.id],
  }),
  orders: many(orders),
}));

export const ordersRelations = relations(orders, ({ one, many }) => ({
  window: one(marketWindows, {
    fields: [orders.windowId],
    references: [marketWindows.id],
  }),
  riskDecision: one(riskDecisions, {
    fields: [orders.riskDecisionId],
    references: [riskDecisions.id],
  }),
  fills: many(fills),
}));

export const fillsRelations = relations(fills, ({ one }) => ({
  order: one(orders, {
    fields: [fills.orderId],
    references: [orders.id],
  }),
}));

// ─── Strategy Relations ─────────────────────────────────────────────────────

export const marketConfigsRelations = relations(marketConfigs, ({ many }) => ({
  strategyAssignments: many(strategyAssignments),
  strategyRuns: many(strategyRuns),
}));

export const strategiesRelations = relations(strategies, ({ many }) => ({
  versions: many(strategyVersions),
}));

export const strategyVersionsRelations = relations(strategyVersions, ({ one, many }) => ({
  strategy: one(strategies, {
    fields: [strategyVersions.strategyId],
    references: [strategies.id],
  }),
  assignments: many(strategyAssignments),
  runs: many(strategyRuns),
}));

export const strategyAssignmentsRelations = relations(strategyAssignments, ({ one }) => ({
  marketConfig: one(marketConfigs, {
    fields: [strategyAssignments.marketConfigId],
    references: [marketConfigs.id],
  }),
  strategyVersion: one(strategyVersions, {
    fields: [strategyAssignments.strategyVersionId],
    references: [strategyVersions.id],
  }),
}));

export const strategyRunsRelations = relations(strategyRuns, ({ one }) => ({
  strategyVersion: one(strategyVersions, {
    fields: [strategyRuns.strategyVersionId],
    references: [strategyVersions.id],
  }),
  marketConfig: one(marketConfigs, {
    fields: [strategyRuns.marketConfigId],
    references: [marketConfigs.id],
  }),
}));
