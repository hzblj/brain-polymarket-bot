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
