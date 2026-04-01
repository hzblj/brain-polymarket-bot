import { describe, expect, it } from 'vitest';
import {
  StrategyVersionConfigSchema,
  StrategyIdentitySchema,
  MarketConfigSchema,
  StrategyAssignmentSchema,
  safeValidate,
} from './index';

describe('Strategy Schemas', () => {
  const validVersionConfig = {
    id: 'btc-5m-momentum-v1',
    label: 'BTC 5m Momentum v1',
    marketSelector: { asset: 'BTC', marketType: 'UP_DOWN', windowSec: 300 },
    agentProfile: {
      regimeAgentProfile: 'regime-default-v1',
      edgeAgentProfile: 'edge-momentum-v1',
      supervisorAgentProfile: 'supervisor-momentum-v1',
    },
    decisionPolicy: {
      allowedDecisions: ['TRADE_LONG', 'TRADE_SHORT', 'NO_TRADE'],
      minConfidence: 0.7,
    },
    filters: {
      maxSpreadBps: 250,
      minDepthScore: 0.6,
      minTimeToCloseSec: 15,
      maxTimeToCloseSec: 90,
    },
    riskProfile: { maxSizeUsd: 20, dailyLossLimitUsd: 50, maxTradesPerWindow: 1 },
    executionPolicy: { entryWindowStartSec: 90, entryWindowEndSec: 10, mode: 'paper' },
  };

  describe('StrategyVersionConfigSchema', () => {
    it('validates a correct config', () => {
      const result = StrategyVersionConfigSchema.safeParse(validVersionConfig);
      expect(result.success).toBe(true);
    });

    it('rejects missing fields', () => {
      const result = StrategyVersionConfigSchema.safeParse({ id: 'test' });
      expect(result.success).toBe(false);
    });

    it('rejects invalid minConfidence', () => {
      const result = StrategyVersionConfigSchema.safeParse({
        ...validVersionConfig,
        decisionPolicy: { ...validVersionConfig.decisionPolicy, minConfidence: 1.5 },
      });
      expect(result.success).toBe(false);
    });

    it('rejects empty allowedDecisions', () => {
      const result = StrategyVersionConfigSchema.safeParse({
        ...validVersionConfig,
        decisionPolicy: { ...validVersionConfig.decisionPolicy, allowedDecisions: [] },
      });
      expect(result.success).toBe(false);
    });

    it('rejects negative maxSizeUsd', () => {
      const result = StrategyVersionConfigSchema.safeParse({
        ...validVersionConfig,
        riskProfile: { ...validVersionConfig.riskProfile, maxSizeUsd: -10 },
      });
      expect(result.success).toBe(false);
    });

    it('rejects invalid execution mode', () => {
      const result = StrategyVersionConfigSchema.safeParse({
        ...validVersionConfig,
        executionPolicy: { ...validVersionConfig.executionPolicy, mode: 'turbo' },
      });
      expect(result.success).toBe(false);
    });
  });

  describe('StrategyIdentitySchema', () => {
    it('validates a correct identity', () => {
      const result = StrategyIdentitySchema.safeParse({
        key: 'btc-5m-momentum',
        name: 'BTC 5m Momentum',
        description: 'Default strategy',
        status: 'active',
        isDefault: true,
      });
      expect(result.success).toBe(true);
    });

    it('rejects invalid status', () => {
      const result = StrategyIdentitySchema.safeParse({
        key: 'test',
        name: 'Test',
        description: 'Test',
        status: 'deleted',
        isDefault: false,
      });
      expect(result.success).toBe(false);
    });
  });

  describe('MarketConfigSchema', () => {
    it('validates a correct market config', () => {
      const result = MarketConfigSchema.safeParse({
        label: 'Bitcoin 5m Up/Down',
        asset: 'BTC',
        marketType: 'UP_DOWN',
        windowSec: 300,
        resolverType: 'polymarket',
        resolverSymbol: 'BTCUSDT',
        defaultEnabled: true,
        isActive: true,
      });
      expect(result.success).toBe(true);
    });

    it('rejects non-positive windowSec', () => {
      const result = MarketConfigSchema.safeParse({
        label: 'Test',
        asset: 'BTC',
        marketType: 'UP_DOWN',
        windowSec: 0,
        resolverType: 'polymarket',
        resolverSymbol: 'BTCUSDT',
        defaultEnabled: true,
        isActive: true,
      });
      expect(result.success).toBe(false);
    });
  });

  describe('safeValidate with strategy schemas', () => {
    it('returns success for valid config', () => {
      const result = safeValidate(StrategyVersionConfigSchema, validVersionConfig);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.id).toBe('btc-5m-momentum-v1');
      }
    });

    it('returns error for invalid config', () => {
      const result = safeValidate(StrategyVersionConfigSchema, {});
      expect(result.success).toBe(false);
    });
  });
});
