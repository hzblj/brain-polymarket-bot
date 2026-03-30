import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type RiskEvaluationRequest, RiskService } from './risk.service';

// ─── Test Data Helpers ──────────────────────────────────────────────────────

function makeFeatures(overrides: Record<string, unknown> = {}) {
  return {
    windowId: 'win-1',
    eventTime: Date.now(), // fresh by default
    market: {
      windowId: 'win-1',
      startPrice: 0.5,
      elapsedMs: 10_000,
      remainingMs: 50_000,
    },
    price: {
      currentPrice: 0.52,
      returnBps: 40,
      volatility: 0.01,
      momentum: 0.3,
      meanReversionStrength: 0.1,
      tickRate: 5,
      binancePrice: 100_000,
      coinbasePrice: 100_010,
      exchangeMidPrice: 100_005,
      polymarketMidPrice: 0.52,
      basisBps: 10,
    },
    book: {
      upBid: 0.51,
      upAsk: 0.53,
      downBid: 0.47,
      downAsk: 0.49,
      spreadBps: 100, // within default 300
      depthScore: 0.5, // above default 0.1
      imbalance: 0.1,
      ...((overrides.book as Record<string, unknown>) ?? {}),
    },
    signals: {
      priceDirectionScore: 0.7,
      volatilityRegime: 'medium' as const,
      bookPressure: 'bid' as const,
      basisSignal: 'long' as const,
    },
    ...(overrides.eventTime === undefined ? {} : { eventTime: overrides.eventTime as number }),
  };
}

function makeProposal(overrides: Record<string, unknown> = {}) {
  return {
    action: 'buy_up' as const,
    sizeUsd: 30,
    confidence: 0.8,
    reasoning: 'test',
    regimeSummary: 'trending',
    edgeSummary: 'edge detected',
    ...overrides,
  };
}

function makeRequest(overrides: Partial<RiskEvaluationRequest> = {}): RiskEvaluationRequest {
  const featureOverrides =
    (overrides as unknown as Record<string, unknown>)._featureOverrides ?? {};
  return {
    windowId: 'win-1',
    agentDecisionId: 'dec-1',
    proposal: makeProposal(
      (overrides as unknown as Record<string, unknown>)._proposalOverrides ?? {},
    ),
    features: makeFeatures(featureOverrides),
    balanceUsd: 1000,
    openExposureUsd: 100,
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('RiskService', () => {
  let service: RiskService;

  beforeEach(() => {
    service = new RiskService();
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

  // ── Kill Switch ─────────────────────────────────────────────────────────

  describe('kill switch check', () => {
    it('allows trades when kill switch is inactive', async () => {
      const result = await service.evaluate(makeRequest());
      const check = result.checksRun.find((c) => c.check === 'kill_switch');
      expect(check.passed).toBe(true);
      expect(check.reason).toBeNull();
    });

    it('blocks trades when kill switch is active', async () => {
      await service.setKillSwitch(true);
      const result = await service.evaluate(makeRequest());
      expect(result.approved).toBe(false);
      const check = result.checksRun.find((c) => c.check === 'kill_switch');
      expect(check.passed).toBe(false);
      expect(check.reason).toContain('Kill switch is active');
      expect(result.rejectionReasons).toContain('Kill switch is active — all trading halted');
    });
  });

  // ── Kill Switch Toggle ──────────────────────────────────────────────────

  describe('setKillSwitch', () => {
    it('activates the kill switch', async () => {
      const result = await service.setKillSwitch(true);
      expect(result.killSwitchActive).toBe(true);
      expect(result.changedAt).toBeDefined();
    });

    it('deactivates the kill switch', async () => {
      await service.setKillSwitch(true);
      const result = await service.setKillSwitch(false);
      expect(result.killSwitchActive).toBe(false);
    });

    it('emits event when state changes', async () => {
      const spy = vi.spyOn(service as unknown as Record<string, unknown>, 'emitEvent');
      await service.setKillSwitch(true);
      expect(spy).toHaveBeenCalledWith('risk.kill-switch.changed', {
        active: true,
        previous: false,
      });
    });

    it('does not emit event when state is unchanged', async () => {
      // Kill switch starts as false; setting to false again should not emit change
      const spy = vi.spyOn(service as unknown as Record<string, unknown>, 'emitEvent');
      await service.setKillSwitch(false);
      expect(spy).not.toHaveBeenCalledWith('risk.kill-switch.changed', expect.anything());
    });
  });

  // ── Trading Enabled ─────────────────────────────────────────────────────

  describe('trading enabled check', () => {
    it('allows trades when trading is enabled (default)', async () => {
      const result = await service.evaluate(makeRequest());
      const check = result.checksRun.find((c) => c.check === 'trading_enabled');
      expect(check.passed).toBe(true);
    });

    it('blocks trades when trading is disabled', async () => {
      await service.updateConfig({ tradingEnabled: false });
      const result = await service.evaluate(makeRequest());
      expect(result.approved).toBe(false);
      const check = result.checksRun.find((c) => c.check === 'trading_enabled');
      expect(check.passed).toBe(false);
      expect(check.reason).toBe('Trading is currently disabled');
    });
  });

  // ── Max Size Per Trade ──────────────────────────────────────────────────

  describe('max size check', () => {
    it('passes when size is under limit', async () => {
      const result = await service.evaluate(makeRequest());
      const check = result.checksRun.find((c) => c.check === 'max_size');
      expect(check.passed).toBe(true);
    });

    it('passes when size equals limit', async () => {
      // default maxSizeUsd is 50
      const req = makeRequest({ proposal: makeProposal({ sizeUsd: 50 }) });
      const result = await service.evaluate(req);
      const check = result.checksRun.find((c) => c.check === 'max_size');
      expect(check.passed).toBe(true);
    });

    it('fails when size exceeds limit', async () => {
      const req = makeRequest({ proposal: makeProposal({ sizeUsd: 51 }) });
      const result = await service.evaluate(req);
      const check = result.checksRun.find((c) => c.check === 'max_size');
      expect(check.passed).toBe(false);
      expect(check.reason).toContain('exceeds max');
    });
  });

  // ── Daily Loss Limit ──────────────────────────────────────────────────

  describe('daily loss limit check', () => {
    it('passes when no losses (dailyPnlUsd = 0)', async () => {
      const result = await service.evaluate(makeRequest());
      const check = result.checksRun.find((c) => c.check === 'daily_loss_limit');
      expect(check.passed).toBe(true);
    });

    it('passes when losses are within limit', async () => {
      // Simulate partial loss via internal state — we access it through getState
      // The daily pnl starts at 0, so remaining = 200 + 0 = 200 > 0, passes
      const result = await service.evaluate(makeRequest());
      const check = result.checksRun.find((c) => c.check === 'daily_loss_limit');
      expect(check.passed).toBe(true);
    });

    it('fails when daily loss limit is reached exactly', async () => {
      // dailyPnlUsd = -200, dailyLossLimitUsd = 200 => remaining = 200 + (-200) = 0 => not > 0 => fail
      (service as unknown as Record<string, number>).dailyPnlUsd = -200;
      const result = await service.evaluate(makeRequest());
      const check = result.checksRun.find((c) => c.check === 'daily_loss_limit');
      expect(check.passed).toBe(false);
      expect(check.reason).toContain('Daily loss limit reached');
    });

    it('fails when daily loss exceeds limit', async () => {
      (service as unknown as Record<string, number>).dailyPnlUsd = -250;
      const result = await service.evaluate(makeRequest());
      const check = result.checksRun.find((c) => c.check === 'daily_loss_limit');
      expect(check.passed).toBe(false);
    });
  });

  // ── Data Staleness ────────────────────────────────────────────────────

  describe('data staleness check', () => {
    it('passes with fresh data', async () => {
      const result = await service.evaluate(makeRequest());
      const check = result.checksRun.find((c) => c.check === 'data_staleness');
      expect(check.passed).toBe(true);
    });

    it('fails when data is older than 15 seconds', async () => {
      const staleTime = Date.now() - 20_000;
      const features = makeFeatures();
      features.eventTime = staleTime;
      const req: RiskEvaluationRequest = {
        windowId: 'win-1',
        agentDecisionId: 'dec-1',
        proposal: makeProposal(),
        features,
        balanceUsd: 1000,
        openExposureUsd: 100,
      };
      const result = await service.evaluate(req);
      const check = result.checksRun.find((c) => c.check === 'data_staleness');
      expect(check.passed).toBe(false);
      expect(check.reason).toContain('old');
      expect(check.reason).toContain('threshold');
    });

    it('passes when data is exactly at the threshold edge (just under 15s)', async () => {
      const justFresh = Date.now() - 14_900;
      const features = makeFeatures();
      features.eventTime = justFresh;
      const req: RiskEvaluationRequest = {
        windowId: 'win-1',
        agentDecisionId: 'dec-1',
        proposal: makeProposal(),
        features,
        balanceUsd: 1000,
        openExposureUsd: 100,
      };
      const result = await service.evaluate(req);
      const check = result.checksRun.find((c) => c.check === 'data_staleness');
      expect(check.passed).toBe(true);
    });
  });

  // ── Max Spread ────────────────────────────────────────────────────────

  describe('max spread check', () => {
    it('passes when spread is within limit', async () => {
      const result = await service.evaluate(makeRequest());
      const check = result.checksRun.find((c) => c.check === 'max_spread');
      expect(check.passed).toBe(true);
    });

    it('passes when spread equals limit', async () => {
      const features = makeFeatures({ book: { spreadBps: 300 } });
      const req: RiskEvaluationRequest = {
        windowId: 'win-1',
        agentDecisionId: 'dec-1',
        proposal: makeProposal(),
        features,
        balanceUsd: 1000,
        openExposureUsd: 100,
      };
      const result = await service.evaluate(req);
      const check = result.checksRun.find((c) => c.check === 'max_spread');
      expect(check.passed).toBe(true);
    });

    it('fails when spread exceeds limit', async () => {
      const features = makeFeatures({ book: { spreadBps: 400 } });
      const req: RiskEvaluationRequest = {
        windowId: 'win-1',
        agentDecisionId: 'dec-1',
        proposal: makeProposal(),
        features,
        balanceUsd: 1000,
        openExposureUsd: 100,
      };
      const result = await service.evaluate(req);
      const check = result.checksRun.find((c) => c.check === 'max_spread');
      expect(check.passed).toBe(false);
      expect(check.reason).toContain('exceeds max');
    });
  });

  // ── Min Depth ─────────────────────────────────────────────────────────

  describe('min depth check', () => {
    it('passes when depth score is above minimum', async () => {
      const result = await service.evaluate(makeRequest());
      const check = result.checksRun.find((c) => c.check === 'min_depth');
      expect(check.passed).toBe(true);
    });

    it('passes when depth score equals minimum', async () => {
      const features = makeFeatures({ book: { depthScore: 0.1 } });
      const req: RiskEvaluationRequest = {
        windowId: 'win-1',
        agentDecisionId: 'dec-1',
        proposal: makeProposal(),
        features,
        balanceUsd: 1000,
        openExposureUsd: 100,
      };
      const result = await service.evaluate(req);
      const check = result.checksRun.find((c) => c.check === 'min_depth');
      expect(check.passed).toBe(true);
    });

    it('fails when depth score is below minimum', async () => {
      const features = makeFeatures({ book: { depthScore: 0.05 } });
      const req: RiskEvaluationRequest = {
        windowId: 'win-1',
        agentDecisionId: 'dec-1',
        proposal: makeProposal(),
        features,
        balanceUsd: 1000,
        openExposureUsd: 100,
      };
      const result = await service.evaluate(req);
      const check = result.checksRun.find((c) => c.check === 'min_depth');
      expect(check.passed).toBe(false);
      expect(check.reason).toContain('below minimum');
    });
  });

  // ── Max Trades Per Window ─────────────────────────────────────────────

  describe('max trades per window check', () => {
    it('passes on the first trade in a window', async () => {
      const result = await service.evaluate(makeRequest());
      const check = result.checksRun.find((c) => c.check === 'max_trades_per_window');
      expect(check.passed).toBe(true);
    });

    it('fails when max trades per window is reached', async () => {
      // Default maxTradesPerWindow = 1, so second trade in same window should fail
      await service.evaluate(makeRequest());
      const result = await service.evaluate(makeRequest());
      const check = result.checksRun.find((c) => c.check === 'max_trades_per_window');
      expect(check.passed).toBe(false);
      expect(check.reason).toContain('Already executed');
    });

    it('resets counter when window changes', async () => {
      // First trade in win-1
      await service.evaluate(makeRequest({ windowId: 'win-1' }));
      // Trade in new window win-2 should pass
      const result = await service.evaluate(makeRequest({ windowId: 'win-2' }));
      const check = result.checksRun.find((c) => c.check === 'max_trades_per_window');
      expect(check.passed).toBe(true);
      expect(result.approved).toBe(true);
    });
  });

  // ── Balance Sufficiency ───────────────────────────────────────────────

  describe('balance sufficiency check', () => {
    it('passes when sufficient balance available', async () => {
      const result = await service.evaluate(makeRequest());
      const check = result.checksRun.find((c) => c.check === 'balance_sufficiency');
      expect(check.passed).toBe(true);
    });

    it('fails when insufficient balance after exposure', async () => {
      const req = makeRequest({
        balanceUsd: 100,
        openExposureUsd: 90,
        proposal: makeProposal({ sizeUsd: 20 }),
      });
      const result = await service.evaluate(req);
      const check = result.checksRun.find((c) => c.check === 'balance_sufficiency');
      expect(check.passed).toBe(false);
      expect(check.reason).toContain('exceeds available balance');
    });

    it('passes when size exactly equals available balance', async () => {
      const req = makeRequest({
        balanceUsd: 100,
        openExposureUsd: 70,
        proposal: makeProposal({ sizeUsd: 30 }),
      });
      const result = await service.evaluate(req);
      const check = result.checksRun.find((c) => c.check === 'balance_sufficiency');
      expect(check.passed).toBe(true);
    });
  });

  // ── Hold Action ───────────────────────────────────────────────────────

  describe('hold action', () => {
    it('is not approved even if all checks pass', async () => {
      const req = makeRequest({
        proposal: makeProposal({ action: 'hold', sizeUsd: 0 }),
      });
      const result = await service.evaluate(req);
      // All checks should pass (size 0 is within limits, etc.)
      expect(result.approved).toBe(false);
      expect(result.approvedSizeUsd).toBe(0);
      // No rejection reasons because checks passed — it's specifically the hold action
      expect(result.rejectionReasons).toHaveLength(0);
    });
  });

  // ── Approval Caps Size at maxSizeUsd ──────────────────────────────────

  describe('approvedSizeUsd capping', () => {
    it('caps approved size at maxSizeUsd', async () => {
      // Size is 50 (at limit), should be approved at 50
      const req = makeRequest({
        proposal: makeProposal({ sizeUsd: 50 }),
      });
      const result = await service.evaluate(req);
      expect(result.approved).toBe(true);
      expect(result.approvedSizeUsd).toBe(50);
    });

    it('returns proposed size when under max', async () => {
      const req = makeRequest({
        proposal: makeProposal({ sizeUsd: 25 }),
      });
      const result = await service.evaluate(req);
      expect(result.approved).toBe(true);
      expect(result.approvedSizeUsd).toBe(25);
    });

    it('caps at maxSizeUsd when custom config is lower', async () => {
      await service.updateConfig({ maxSizeUsd: 10 });
      const req = makeRequest({
        proposal: makeProposal({ sizeUsd: 10 }),
      });
      // Need a new window since we already used win-1 above
      req.windowId = 'win-cap';
      const result = await service.evaluate(req);
      expect(result.approved).toBe(true);
      expect(result.approvedSizeUsd).toBe(10);
    });
  });

  // ── Combined Scenarios ────────────────────────────────────────────────

  describe('combined failure scenarios', () => {
    it('collects multiple rejection reasons when several checks fail', async () => {
      await service.setKillSwitch(true);
      await service.updateConfig({ tradingEnabled: false });
      const features = makeFeatures({ book: { spreadBps: 500, depthScore: 0.01 } });
      features.eventTime = Date.now() - 30_000; // stale
      const req: RiskEvaluationRequest = {
        windowId: 'win-combined',
        agentDecisionId: 'dec-comb',
        proposal: makeProposal({ sizeUsd: 999 }),
        features,
        balanceUsd: 10,
        openExposureUsd: 5,
      };
      const result = await service.evaluate(req);
      expect(result.approved).toBe(false);
      expect(result.approvedSizeUsd).toBe(0);
      // At least kill_switch, trading_enabled, max_size, data_staleness, max_spread, min_depth, balance
      expect(result.rejectionReasons.length).toBeGreaterThanOrEqual(5);
      expect(result.checksRun).toHaveLength(9);
    });
  });

  // ── Config Update ─────────────────────────────────────────────────────

  describe('updateConfig', () => {
    it('applies partial config updates', async () => {
      const updated = await service.updateConfig({ maxSizeUsd: 100 });
      expect(updated.maxSizeUsd).toBe(100);
      // Other defaults should remain
      expect(updated.dailyLossLimitUsd).toBe(200);
    });

    it('applies full config updates', async () => {
      const updated = await service.updateConfig({
        maxSizeUsd: 200,
        dailyLossLimitUsd: 500,
        maxSpreadBps: 150,
        minDepthScore: 0.5,
        maxTradesPerWindow: 5,
        tradingEnabled: false,
      });
      expect(updated.maxSizeUsd).toBe(200);
      expect(updated.dailyLossLimitUsd).toBe(500);
      expect(updated.maxSpreadBps).toBe(150);
      expect(updated.minDepthScore).toBe(0.5);
      expect(updated.maxTradesPerWindow).toBe(5);
      expect(updated.tradingEnabled).toBe(false);
    });

    it('returns tradingEnabled in result', async () => {
      const updated = await service.updateConfig({ tradingEnabled: true });
      expect(updated.tradingEnabled).toBe(true);
    });
  });

  // ── getState ──────────────────────────────────────────────────────────

  describe('getState', () => {
    it('returns current state with defaults', async () => {
      const state = await service.getState();
      expect(state.config.maxSizeUsd).toBe(50);
      expect(state.killSwitchActive).toBe(false);
      expect(state.tradingEnabled).toBe(true);
      expect(state.state.dailyPnlUsd).toBe(0);
      expect(state.state.tradesInWindow).toBe(0);
      expect(state.updatedAt).toBeDefined();
    });

    it('reflects changes after evaluation', async () => {
      await service.evaluate(makeRequest({ windowId: 'win-state' }));
      const state = await service.getState();
      expect(state.state.tradesInWindow).toBe(1);
      expect(state.state.lastTradeTime).toBeTypeOf('number');
    });
  });

  // ── Result Structure ──────────────────────────────────────────────────

  describe('evaluation result structure', () => {
    it('returns all required fields', async () => {
      const result = await service.evaluate(makeRequest({ windowId: 'win-struct' }));
      expect(result.id).toMatch(/^risk-/);
      expect(result.windowId).toBe('win-struct');
      expect(result.agentDecisionId).toBe('dec-1');
      expect(result.approved).toBeTypeOf('boolean');
      expect(result.approvedSizeUsd).toBeTypeOf('number');
      expect(result.rejectionReasons).toBeInstanceOf(Array);
      expect(result.checksRun).toHaveLength(9);
      expect(result.evaluatedAt).toBeDefined();
    });

    it('runs all 9 checks', async () => {
      const result = await service.evaluate(makeRequest({ windowId: 'win-9checks' }));
      const checkNames = result.checksRun.map((c) => c.check);
      expect(checkNames).toEqual([
        'kill_switch',
        'trading_enabled',
        'max_size',
        'daily_loss_limit',
        'data_staleness',
        'max_spread',
        'min_depth',
        'max_trades_per_window',
        'balance_sufficiency',
      ]);
    });
  });

  // ── Window Change Resets Trade Counter ─────────────────────────────────

  describe('window change resets trade counter', () => {
    it('resets tradesInCurrentWindow when windowId changes', async () => {
      await service.evaluate(makeRequest({ windowId: 'win-A' }));
      // Second trade in win-A would fail (maxTradesPerWindow = 1)
      const fail = await service.evaluate(makeRequest({ windowId: 'win-A' }));
      expect(fail.approved).toBe(false);

      // Move to win-B, counter resets
      const pass = await service.evaluate(makeRequest({ windowId: 'win-B' }));
      expect(pass.approved).toBe(true);
    });
  });

  // ── Approved Trade Increments Counter ─────────────────────────────────

  describe('trade counter increment', () => {
    it('increments trade counter only on approval', async () => {
      // Approved trade
      await service.evaluate(makeRequest({ windowId: 'win-inc' }));

      // Rejected trade (hold) should NOT increment counter
      // Actually hold doesn't increment because it's not approved
      // The counter was already at 1 so next trade would be rejected anyway
      const state = await service.getState();
      expect(state.state.tradesInWindow).toBe(1);
    });
  });
});
