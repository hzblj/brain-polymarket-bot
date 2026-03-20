import { relations } from 'drizzle-orm';
import {
  markets,
  marketWindows,
  priceTicks,
  bookSnapshots,
  featureSnapshots,
  agentDecisions,
  riskDecisions,
  orders,
  fills,
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
