import { HttpException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigManagementService } from './config-management.service';

describe('ConfigManagementService', () => {
  let service: ConfigManagementService;

  beforeEach(() => {
    service = new ConfigManagementService();
    vi.spyOn(console, 'log').mockImplementation(() => {
      /* noop */
    });
    vi.spyOn(console, 'error').mockImplementation(() => {
      /* noop */
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── getEffectiveConfig ────────────────────────────────────────────────

  describe('getEffectiveConfig', () => {
    it('returns config with default values', async () => {
      const config = await service.getEffectiveConfig();
      expect(config.source).toBe('defaults');
      expect(config.updatedAt).toBeDefined();
    });

    it('returns correct default trading config', async () => {
      const config = await service.getEffectiveConfig();
      expect(config.trading.edgeThresholdMin).toBe(0.05);
      expect(config.trading.edgeThresholdStrong).toBe(0.15);
      expect(config.trading.maxSpreadBps).toBe(300);
      expect(config.trading.minDepthScore).toBe(0.1);
      expect(config.trading.maxSizeUsd).toBe(50);
      expect(config.trading.mode).toBe('disabled');
    });

    it('returns correct default risk config', async () => {
      const config = await service.getEffectiveConfig();
      expect(config.risk.dailyLossLimitUsd).toBe(200);
      expect(config.risk.maxTradesPerWindow).toBe(1);
      expect(config.risk.maxSizeUsd).toBe(50);
      expect(config.risk.maxSpreadBps).toBe(300);
      expect(config.risk.minDepthScore).toBe(0.1);
    });

    it('returns correct default provider config', async () => {
      const config = await service.getEffectiveConfig();
      expect(config.provider.provider).toBe('anthropic');
      expect(config.provider.model).toBe('claude-sonnet-4-20250514');
      expect(config.provider.temperature).toBe(0);
      expect(config.provider.timeoutMs).toBe(30_000);
      expect(config.provider.maxRetries).toBe(2);
    });

    it('returns correct default feature flags', async () => {
      const config = await service.getEffectiveConfig();
      expect(config.featureFlags.agentRegimeEnabled).toBe(true);
      expect(config.featureFlags.agentEdgeEnabled).toBe(true);
      expect(config.featureFlags.agentSupervisorEnabled).toBe(true);
      expect(config.featureFlags.liveExecutionEnabled).toBe(false);
      expect(config.featureFlags.replayEnabled).toBe(true);
      expect(config.featureFlags.metricsEnabled).toBe(true);
    });

    it('returns a defensive copy (mutations do not affect internal state)', async () => {
      const config1 = await service.getEffectiveConfig();
      config1.trading.maxSizeUsd = 9999;
      const config2 = await service.getEffectiveConfig();
      expect(config2.trading.maxSizeUsd).toBe(50);
    });
  });

  // ── updateConfig ──────────────────────────────────────────────────────

  describe('updateConfig', () => {
    it('partially updates trading config', async () => {
      const result = await service.updateConfig({
        trading: { maxSizeUsd: 100 },
      });
      expect(result.trading.maxSizeUsd).toBe(100);
      // Other fields remain at defaults
      expect(result.trading.edgeThresholdMin).toBe(0.05);
      expect(result.trading.mode).toBe('disabled');
    });

    it('partially updates risk config', async () => {
      const result = await service.updateConfig({
        risk: { dailyLossLimitUsd: 500, maxTradesPerWindow: 3 },
      });
      expect(result.risk.dailyLossLimitUsd).toBe(500);
      expect(result.risk.maxTradesPerWindow).toBe(3);
      // Unchanged fields
      expect(result.risk.maxSizeUsd).toBe(50);
    });

    it('partially updates provider config', async () => {
      const result = await service.updateConfig({
        provider: { model: 'gpt-4o', provider: 'openai' },
      });
      expect(result.provider.model).toBe('gpt-4o');
      expect(result.provider.provider).toBe('openai');
      // Unchanged
      expect(result.provider.temperature).toBe(0);
    });

    it('partially updates feature flags', async () => {
      const result = await service.updateConfig({
        featureFlags: { liveExecutionEnabled: true },
      });
      expect(result.featureFlags.liveExecutionEnabled).toBe(true);
      // Others unchanged
      expect(result.featureFlags.agentRegimeEnabled).toBe(true);
      expect(result.featureFlags.replayEnabled).toBe(true);
    });

    it('updates multiple sections at once', async () => {
      const result = await service.updateConfig({
        trading: { mode: 'paper' },
        risk: { maxSizeUsd: 75 },
        provider: { temperature: 0.5 },
        featureFlags: { metricsEnabled: false },
      });
      expect(result.trading.mode).toBe('paper');
      expect(result.risk.maxSizeUsd).toBe(75);
      expect(result.provider.temperature).toBe(0.5);
      expect(result.featureFlags.metricsEnabled).toBe(false);
    });

    it('sets source to database after update', async () => {
      const result = await service.updateConfig({
        trading: { maxSizeUsd: 100 },
      });
      expect(result.source).toBe('database');
    });

    it('updates the updatedAt timestamp', async () => {
      const before = await service.getEffectiveConfig();
      // Small delay to ensure timestamp difference
      await new Promise((r) => setTimeout(r, 5));
      const after = await service.updateConfig({ trading: { maxSizeUsd: 100 } });
      expect(new Date(after.updatedAt).getTime()).toBeGreaterThanOrEqual(
        new Date(before.updatedAt).getTime(),
      );
    });

    it('successive updates accumulate correctly', async () => {
      await service.updateConfig({ trading: { maxSizeUsd: 100 } });
      await service.updateConfig({ trading: { mode: 'live' } });
      const config = await service.getEffectiveConfig();
      expect(config.trading.maxSizeUsd).toBe(100);
      expect(config.trading.mode).toBe('live');
    });

    it('empty update preserves all defaults', async () => {
      const result = await service.updateConfig({});
      expect(result.trading.maxSizeUsd).toBe(50);
      expect(result.risk.dailyLossLimitUsd).toBe(200);
      expect(result.source).toBe('database');
    });
  });

  // ── Feature Flags ─────────────────────────────────────────────────────

  describe('getFeatureFlags', () => {
    it('returns default feature flags', async () => {
      const flags = await service.getFeatureFlags();
      expect(flags.agentRegimeEnabled).toBe(true);
      expect(flags.agentEdgeEnabled).toBe(true);
      expect(flags.agentSupervisorEnabled).toBe(true);
      expect(flags.liveExecutionEnabled).toBe(false);
      expect(flags.replayEnabled).toBe(true);
      expect(flags.metricsEnabled).toBe(true);
    });

    it('returns updated flags after toggle', async () => {
      await service.updateConfig({
        featureFlags: { liveExecutionEnabled: true, replayEnabled: false },
      });
      const flags = await service.getFeatureFlags();
      expect(flags.liveExecutionEnabled).toBe(true);
      expect(flags.replayEnabled).toBe(false);
      // Others unchanged
      expect(flags.agentRegimeEnabled).toBe(true);
    });

    it('returns a defensive copy', async () => {
      const flags1 = await service.getFeatureFlags();
      flags1.metricsEnabled = false;
      const flags2 = await service.getFeatureFlags();
      expect(flags2.metricsEnabled).toBe(true);
    });

    it('toggling individual flags does not affect others', async () => {
      await service.updateConfig({ featureFlags: { agentRegimeEnabled: false } });
      const flags = await service.getFeatureFlags();
      expect(flags.agentRegimeEnabled).toBe(false);
      expect(flags.agentEdgeEnabled).toBe(true);
      expect(flags.agentSupervisorEnabled).toBe(true);
      expect(flags.liveExecutionEnabled).toBe(false);
      expect(flags.replayEnabled).toBe(true);
      expect(flags.metricsEnabled).toBe(true);
    });
  });

  // ── Zod Validation ────────────────────────────────────────────────────

  describe('Zod validation on update', () => {
    it('rejects negative maxSizeUsd', async () => {
      await expect(service.updateConfig({ trading: { maxSizeUsd: -10 } })).rejects.toThrow(
        HttpException,
      );
    });

    it('rejects zero maxSizeUsd (must be positive)', async () => {
      await expect(service.updateConfig({ trading: { maxSizeUsd: 0 } })).rejects.toThrow(
        HttpException,
      );
    });

    it('rejects edgeThresholdMin above 1', async () => {
      await expect(service.updateConfig({ trading: { edgeThresholdMin: 1.5 } })).rejects.toThrow(
        HttpException,
      );
    });

    it('rejects edgeThresholdMin below 0', async () => {
      await expect(service.updateConfig({ trading: { edgeThresholdMin: -0.1 } })).rejects.toThrow(
        HttpException,
      );
    });

    it('rejects temperature above 2', async () => {
      await expect(service.updateConfig({ provider: { temperature: 3 } })).rejects.toThrow(
        HttpException,
      );
    });

    it('rejects negative temperature', async () => {
      await expect(service.updateConfig({ provider: { temperature: -1 } })).rejects.toThrow(
        HttpException,
      );
    });

    it('rejects invalid provider value', async () => {
      await expect(
        service.updateConfig({ provider: { provider: 'invalid' as unknown as 'anthropic' } }),
      ).rejects.toThrow(HttpException);
    });

    it('rejects invalid mode value', async () => {
      await expect(
        service.updateConfig({ trading: { mode: 'invalid' as unknown as 'disabled' } }),
      ).rejects.toThrow(HttpException);
    });

    it('rejects non-integer maxTradesPerWindow', async () => {
      await expect(service.updateConfig({ risk: { maxTradesPerWindow: 1.5 } })).rejects.toThrow(
        HttpException,
      );
    });

    it('rejects negative dailyLossLimitUsd', async () => {
      await expect(service.updateConfig({ risk: { dailyLossLimitUsd: -100 } })).rejects.toThrow(
        HttpException,
      );
    });

    it('rejects zero maxTradesPerWindow (must be positive)', async () => {
      await expect(service.updateConfig({ risk: { maxTradesPerWindow: 0 } })).rejects.toThrow(
        HttpException,
      );
    });

    it('rejects negative maxRetries', async () => {
      await expect(service.updateConfig({ provider: { maxRetries: -1 } })).rejects.toThrow(
        HttpException,
      );
    });

    it('rejects empty model string', async () => {
      await expect(service.updateConfig({ provider: { model: '' } })).rejects.toThrow(
        HttpException,
      );
    });

    it('rejects negative timeoutMs', async () => {
      await expect(service.updateConfig({ provider: { timeoutMs: -100 } })).rejects.toThrow(
        HttpException,
      );
    });

    it('accepts valid boundary values', async () => {
      const result = await service.updateConfig({
        trading: {
          edgeThresholdMin: 0,
          edgeThresholdStrong: 1,
          maxSpreadBps: 1,
          minDepthScore: 0,
          maxSizeUsd: 0.01,
          mode: 'live',
        },
        provider: {
          temperature: 0,
          maxRetries: 0,
        },
        risk: {
          minDepthScore: 0,
        },
      });
      expect(result.trading.edgeThresholdMin).toBe(0);
      expect(result.trading.edgeThresholdStrong).toBe(1);
      expect(result.provider.temperature).toBe(0);
      expect(result.provider.maxRetries).toBe(0);
    });

    it('provides error details in rejection', async () => {
      try {
        await service.updateConfig({ trading: { maxSizeUsd: -10 } });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(HttpException);
        const response = (err as HttpException).getResponse();
        expect(response).toHaveProperty('message', 'Invalid config update');
        expect(response).toHaveProperty('errors');
        expect((response as Record<string, unknown[]>).errors.length).toBeGreaterThan(0);
      }
    });
  });

  // ── Invalid Config Values Rejected ────────────────────────────────────

  describe('invalid config values rejected', () => {
    it('does not mutate state on validation failure', async () => {
      const before = await service.getEffectiveConfig();
      try {
        await service.updateConfig({ trading: { maxSizeUsd: -10 } });
      } catch {
        // expected
      }
      const after = await service.getEffectiveConfig();
      expect(after.trading.maxSizeUsd).toBe(before.trading.maxSizeUsd);
    });

    it('rejects boolean where number expected', async () => {
      await expect(
        service.updateConfig({ risk: { maxSizeUsd: true as unknown as number } }),
      ).rejects.toThrow(HttpException);
    });

    it('rejects string where number expected', async () => {
      await expect(
        service.updateConfig({ risk: { maxSizeUsd: 'fifty' as unknown as number } }),
      ).rejects.toThrow(HttpException);
    });
  });

  // ── Market Config ────────────────────────────────────────────────────

  describe('getMarketConfig', () => {
    it('returns default Bitcoin 5m market config', async () => {
      const market = await service.getMarketConfig();
      expect(market.id).toBe('bitcoin-5m-default');
      expect(market.label).toBe('bitcoin-5m');
      expect(market.asset).toBe('BTC');
      expect(market.marketType).toBe('UP_DOWN');
      expect(market.windowSec).toBe(300);
      expect(market.defaultEnabled).toBe(true);
      expect(market.resolver.type).toBe('CHAINLINK_PROXY');
      expect(market.resolver.symbol).toBe('BTC/USD');
    });

    it('returns a defensive copy', async () => {
      const m1 = await service.getMarketConfig();
      m1.asset = 'ETH';
      const m2 = await service.getMarketConfig();
      expect(m2.asset).toBe('BTC');
    });
  });

  describe('updateMarketConfig', () => {
    it('partially updates market config', async () => {
      const result = await service.updateMarketConfig({ asset: 'ETH', windowSec: 900 });
      expect(result.asset).toBe('ETH');
      expect(result.windowSec).toBe(900);
      expect(result.label).toBe('bitcoin-5m'); // unchanged
    });

    it('updates resolver', async () => {
      const result = await service.updateMarketConfig({
        resolver: { symbol: 'ETH/USD' },
      });
      expect(result.resolver.symbol).toBe('ETH/USD');
      expect(result.resolver.type).toBe('CHAINLINK_PROXY'); // unchanged
    });

    it('rejects invalid windowSec', async () => {
      await expect(service.updateMarketConfig({ windowSec: -1 })).rejects.toThrow(HttpException);
    });

    it('rejects empty asset string', async () => {
      await expect(service.updateMarketConfig({ asset: '' })).rejects.toThrow(HttpException);
    });
  });

  // ── Reset Defaults ─────────────────────────────────────────────────

  describe('resetDefaults', () => {
    it('resets all config to defaults after modification', async () => {
      await service.updateConfig({ trading: { maxSizeUsd: 999 } });
      await service.updateMarketConfig({ asset: 'SOL' });

      const result = await service.resetDefaults();

      expect(result.trading.maxSizeUsd).toBe(50);
      expect(result.market.asset).toBe('BTC');
      expect(result.market.windowSec).toBe(300);
      expect(result.source).toBe('defaults');
    });

    it('effective config includes market after reset', async () => {
      const config = await service.resetDefaults();
      expect(config.market).toBeDefined();
      expect(config.market.id).toBe('bitcoin-5m-default');
    });
  });

  // ── Effective Config includes market ────────────────────────────────

  describe('getEffectiveConfig includes market', () => {
    it('includes market in effective config', async () => {
      const config = await service.getEffectiveConfig();
      expect(config.market).toBeDefined();
      expect(config.market.asset).toBe('BTC');
      expect(config.market.windowSec).toBe(300);
    });
  });

  // ── Event Emission ────────────────────────────────────────────────────

  describe('event emission', () => {
    it('emits config.updated event on successful update', async () => {
      const spy = vi.spyOn(service as unknown as Record<string, unknown>, 'emitEvent');
      await service.updateConfig({ trading: { maxSizeUsd: 100 } });
      expect(spy).toHaveBeenCalledWith(
        'config.updated',
        expect.objectContaining({ trading: expect.any(Object) }),
      );
    });
  });
});
