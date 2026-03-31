'use client';

import { useQuery } from '@tanstack/react-query';
import {
  getBookHistory,
  getClosedTrades,
  getEvents,
  getFeatureFlags,
  getFeedStatus,
  getMarketSnapshot,
  getOpenTrades,
  getPipeline,
  getPriceHistory,
  getServiceHealth,
  getSimulationSummary,
  getStrategies,
  getSystemConfig,
  getSystemState,
  getTodayMetrics,
  getWhaleFeatures,
  getWhaleTransactions,
  getWhaleHistory,
  getBlockchainActivity,
  getDerivativesFeatures,
  getDerivativesLiquidations,
  getDerivativesHistory,
  getTradeAnalyses,
  getStrategyReports,
  getOptimizerStatus,
  getAgentTraces,
  getAgentContext,
  getReplaySummary,
  getRiskState,
} from './api';

// ─── Live data hooks (2-5s refetch) ────────────────────────────────────────

export function useSystemState() {
  return useQuery({
    queryKey: ['systemState'],
    queryFn: getSystemState,
    refetchInterval: 3_000,
  });
}

export function useMarketSnapshot() {
  return useQuery({
    queryKey: ['marketSnapshot'],
    queryFn: getMarketSnapshot,
    refetchInterval: 2_000,
  });
}

export function usePipeline() {
  return useQuery({
    queryKey: ['pipeline'],
    queryFn: getPipeline,
    refetchInterval: 3_000,
  });
}

export function useOpenTrades() {
  return useQuery({
    queryKey: ['openTrades'],
    queryFn: getOpenTrades,
    refetchInterval: 2_000,
  });
}

export function useServiceHealth() {
  return useQuery({
    queryKey: ['serviceHealth'],
    queryFn: getServiceHealth,
    refetchInterval: 5_000,
  });
}

import type { TimeRange } from './api';

export function usePriceHistory(range: TimeRange = '5m') {
  return useQuery({
    queryKey: ['priceHistory', range],
    queryFn: () => getPriceHistory(range),
    refetchInterval: 2_000,
  });
}

export function useBookHistory(range: TimeRange = '5m') {
  return useQuery({
    queryKey: ['bookHistory', range],
    queryFn: () => getBookHistory(range),
    refetchInterval: 2_000,
  });
}

export function useEvents() {
  return useQuery({
    queryKey: ['events'],
    queryFn: getEvents,
    refetchInterval: 3_000,
  });
}

export function useFeedStatus() {
  return useQuery({
    queryKey: ['feedStatus'],
    queryFn: getFeedStatus,
    refetchInterval: 5_000,
  });
}

// ─── Summary hooks (10-30s refetch) ────────────────────────────────────────

export function useClosedTrades() {
  return useQuery({
    queryKey: ['closedTrades'],
    queryFn: getClosedTrades,
    refetchInterval: 10_000,
  });
}

export function useTodayMetrics() {
  return useQuery({
    queryKey: ['todayMetrics'],
    queryFn: getTodayMetrics,
    refetchInterval: 10_000,
  });
}

export function useSimulationSummary() {
  return useQuery({
    queryKey: ['simulationSummary'],
    queryFn: getSimulationSummary,
    refetchInterval: 30_000,
  });
}

// ─── Whale tracker hooks (3-5s refetch) ──────────────────────────────────

export function useWhaleFeatures() {
  return useQuery({
    queryKey: ['whaleFeatures'],
    queryFn: getWhaleFeatures,
    refetchInterval: 3_000,
  });
}

export function useWhaleTransactions() {
  return useQuery({
    queryKey: ['whaleTransactions'],
    queryFn: getWhaleTransactions,
    refetchInterval: 5_000,
  });
}

export function useWhaleHistory() {
  return useQuery({
    queryKey: ['whaleHistory'],
    queryFn: getWhaleHistory,
    refetchInterval: 5_000,
  });
}

export function useBlockchainActivity() {
  return useQuery({
    queryKey: ['blockchainActivity'],
    queryFn: getBlockchainActivity,
    refetchInterval: 15_000,
  });
}

// ─── Derivatives feed hooks (3-5s refetch) ───────────────────────────────

export function useDerivativesFeatures() {
  return useQuery({
    queryKey: ['derivativesFeatures'],
    queryFn: getDerivativesFeatures,
    refetchInterval: 3_000,
  });
}

export function useDerivativesLiquidations() {
  return useQuery({
    queryKey: ['derivativesLiquidations'],
    queryFn: getDerivativesLiquidations,
    refetchInterval: 3_000,
  });
}

export function useDerivativesHistory() {
  return useQuery({
    queryKey: ['derivativesHistory'],
    queryFn: getDerivativesHistory,
    refetchInterval: 5_000,
  });
}

// ─── Trade analysis & optimizer hooks (10-30s refetch) ──────────────────

export function useTradeAnalyses(verdict?: string) {
  return useQuery({
    queryKey: ['tradeAnalyses', verdict],
    queryFn: () => getTradeAnalyses({ verdict, limit: 100 }),
    refetchInterval: 10_000,
  });
}

export function useStrategyReports() {
  return useQuery({
    queryKey: ['strategyReports'],
    queryFn: () => getStrategyReports(10),
    refetchInterval: 30_000,
  });
}

export function useOptimizerStatus() {
  return useQuery({
    queryKey: ['optimizerStatus'],
    queryFn: getOptimizerStatus,
    refetchInterval: 10_000,
  });
}

// ─── Agent & Replay hooks (5-10s refetch) ────────────────────────────────

export function useAgentTraces(agentType?: string) {
  return useQuery({
    queryKey: ['agentTraces', agentType],
    queryFn: () => getAgentTraces({ agentType, limit: 50 }),
    refetchInterval: 5_000,
  });
}

export function useAgentContext() {
  return useQuery({
    queryKey: ['agentContext'],
    queryFn: getAgentContext,
    refetchInterval: 10_000,
  });
}

export function useReplaySummary() {
  return useQuery({
    queryKey: ['replaySummary'],
    queryFn: getReplaySummary,
    refetchInterval: 30_000,
  });
}

export function useRiskState() {
  return useQuery({
    queryKey: ['riskState'],
    queryFn: getRiskState,
    refetchInterval: 5_000,
  });
}

// ─── Config & Strategy hooks (30s refetch) ───────────────────────────────

export function useSystemConfig() {
  return useQuery({ queryKey: ['systemConfig'], queryFn: getSystemConfig, refetchInterval: 30_000 });
}

export function useStrategies() {
  return useQuery({ queryKey: ['strategies'], queryFn: getStrategies, refetchInterval: 30_000 });
}

export function useFeatureFlags() {
  return useQuery({ queryKey: ['featureFlags'], queryFn: getFeatureFlags, refetchInterval: 30_000 });
}
