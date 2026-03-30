import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventBus } from '@brain/events';
import { PipelineService } from './pipeline.service';

// ─── Mock Feature Payload ──────────────────────────────────────────────────

const mockFeatures = {
  windowId: 'btc-5m-test',
  eventTime: Date.now(),
  market: {
    windowId: 'btc-5m-test',
    startPrice: 84250,
    elapsedMs: 180000,
    remainingMs: 120000,
  },
  price: {
    currentPrice: 84300,
    returnBps: 5.93,
    volatility: 0.0008,
    momentum: 0.55,
    meanReversionStrength: 0,
    tickRate: 0,
    binancePrice: 84300,
    coinbasePrice: 84300,
    exchangeMidPrice: 84300,
    polymarketMidPrice: 0.565,
    basisBps: 0,
  },
  book: {
    upBid: 0.55,
    upAsk: 0.58,
    downBid: 0.41,
    downAsk: 0.44,
    spreadBps: 530,
    depthScore: 0.6,
    imbalance: 0.05,
  },
  signals: {
    priceDirectionScore: 0.1,
    volatilityRegime: 'medium',
    bookPressure: 'neutral',
    basisSignal: 'neutral',
    tradeable: true,
  },
};

// ─── Mock Agent / Risk / Execution Responses ────────────────────────────────

const mockRegimeResult = {
  parsedOutput: { regime: 'trending', confidence: 0.8 },
};

const mockEdgeResult = {
  parsedOutput: { direction: 'up', magnitude: 0.6, confidence: 0.75 },
};

const mockSupervisorBuy = {
  id: 'sup-001',
  parsedOutput: {
    action: 'buy_up',
    sizeUsd: 10,
    confidence: 0.7,
    reasoning: 'Strong upward momentum',
  },
};

const mockSupervisorHold = {
  id: 'sup-002',
  parsedOutput: {
    action: 'hold',
    sizeUsd: 0,
    confidence: 0.3,
    reasoning: 'Uncertain regime',
  },
};

const mockRiskState = {
  state: { openPositionUsd: 0, drawdownPct: 0 },
  config: { maxPositionUsd: 50 },
};

const mockRiskApproved = {
  id: 'risk-001',
  approved: true,
  approvedSizeUsd: 10,
  rejectionReasons: [],
};

const mockRiskRejected = {
  id: 'risk-002',
  approved: false,
  approvedSizeUsd: 0,
  rejectionReasons: ['Max daily loss exceeded'],
};

const mockOrder = {
  id: 'order-001',
  status: 'filled',
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function jsonResponse(data: unknown, ok = true) {
  return Promise.resolve({
    ok,
    json: () => Promise.resolve(data),
  });
}

function healthOk() {
  return jsonResponse({ ok: true });
}

function serviceOk(data: unknown) {
  return jsonResponse({ ok: true, data });
}

function serviceNull() {
  return jsonResponse({ ok: true, data: null });
}

/**
 * Build a fetch mock that routes by URL substring.
 * Pass overrides to customise specific endpoints.
 */
function buildFetchMock(overrides: Record<string, () => Promise<unknown>> = {}) {
  return vi.fn().mockImplementation((url: string) => {
    // Check overrides first
    for (const [pattern, handler] of Object.entries(overrides)) {
      if (url.includes(pattern)) return handler();
    }

    // Default healthy responses for the full happy-path
    if (url.includes('/health')) return healthOk();
    if (url.includes('/features/current')) return serviceOk(mockFeatures);
    if (url.includes('/risk/state')) return serviceOk(mockRiskState);
    if (url.includes('/regime/evaluate')) return serviceOk(mockRegimeResult);
    if (url.includes('/edge/evaluate')) return serviceOk(mockEdgeResult);
    if (url.includes('/supervisor/evaluate')) return serviceOk(mockSupervisorBuy);
    if (url.includes('/risk/evaluate')) return serviceOk(mockRiskApproved);
    if (url.includes('/paper-order')) return serviceOk(mockOrder);
    if (url.includes('/live-order')) return serviceOk(mockOrder);

    // Fallback: 404
    return Promise.resolve({ ok: false, status: 404 });
  });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('PipelineService', () => {
  let service: PipelineService;
  let eventBus: EventBus;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    eventBus = new EventBus();
    service = new PipelineService(eventBus);
    // Do NOT call onModuleInit — we avoid the interval loop in tests
  });

  afterEach(() => {
    service.onModuleDestroy();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    eventBus.onModuleDestroy();
  });

  // ─── getStatus ──────────────────────────────────────────────────────────────

  describe('getStatus()', () => {
    it('returns the expected structure', () => {
      const status = service.getStatus();

      expect(status).toHaveProperty('enabled');
      expect(status).toHaveProperty('running');
      expect(status).toHaveProperty('executionMode');
      expect(status).toHaveProperty('cycleCount');
      expect(status).toHaveProperty('intervalMs');
      expect(status).toHaveProperty('lastResult');
      expect(status).toHaveProperty('serviceUrls');

      expect(status.cycleCount).toBe(0);
      expect(status.lastResult).toBeNull();
      expect(status.enabled).toBe(true);
      expect(status.running).toBe(false);

      const urls = status.serviceUrls as Record<string, string>;
      expect(urls).toHaveProperty('featureEngine');
      expect(urls).toHaveProperty('agentGateway');
      expect(urls).toHaveProperty('riskService');
      expect(urls).toHaveProperty('executionService');
    });
  });

  // ─── setEnabled ─────────────────────────────────────────────────────────────

  describe('setEnabled()', () => {
    it('setEnabled(false) disables the pipeline', () => {
      service.setEnabled(false);

      const status = service.getStatus();
      expect(status.enabled).toBe(false);
    });

    it('setEnabled(true) re-enables the pipeline and starts the loop', () => {
      service.setEnabled(false);
      service.setEnabled(true);

      const status = service.getStatus();
      expect(status.enabled).toBe(true);
    });
  });

  // ─── triggerOnce ────────────────────────────────────────────────────────────

  describe('triggerOnce()', () => {
    it('runs a single cycle and returns a result', async () => {
      vi.stubGlobal('fetch', buildFetchMock());

      const result = await service.triggerOnce();

      expect(result).toHaveProperty('cycle', 1);
      expect(result).toHaveProperty('timestamp');
      expect(result).toHaveProperty('stage');
      expect(result).toHaveProperty('durationMs');
      expect(result).toHaveProperty('details');
    });
  });

  // ─── no_features ────────────────────────────────────────────────────────────

  describe('cycle returns no_features', () => {
    it('when feature-engine returns null data', async () => {
      vi.stubGlobal(
        'fetch',
        buildFetchMock({
          '/features/current': () => serviceNull(),
        }),
      );

      const result = await service.triggerOnce();

      expect(result.stage).toBe('no_features');
      expect(result.details).toHaveProperty('reason');
    });

    it('when feature-engine response is not ok', async () => {
      vi.stubGlobal(
        'fetch',
        buildFetchMock({
          '/features/current': () => jsonResponse({ ok: false }),
        }),
      );

      const result = await service.triggerOnce();

      expect(result.stage).toBe('no_features');
    });
  });

  // ─── not_tradeable ──────────────────────────────────────────────────────────

  describe('cycle returns not_tradeable', () => {
    it('when features.signals.tradeable is false', async () => {
      const untradeable = {
        ...mockFeatures,
        signals: { ...mockFeatures.signals, tradeable: false },
      };

      vi.stubGlobal(
        'fetch',
        buildFetchMock({
          '/features/current': () => serviceOk(untradeable),
        }),
      );

      const result = await service.triggerOnce();

      expect(result.stage).toBe('not_tradeable');
      expect(result.details).toHaveProperty('windowId', 'btc-5m-test');
    });
  });

  // ─── skipped (duplicate windowId) ───────────────────────────────────────────

  describe('cycle returns skipped', () => {
    it('when the same windowId was already traded', async () => {
      vi.stubGlobal('fetch', buildFetchMock());

      // First cycle should execute successfully
      const first = await service.triggerOnce();
      expect(first.stage).toBe('executed');

      // Second cycle with the same windowId should be skipped
      const second = await service.triggerOnce();
      expect(second.stage).toBe('skipped');
      expect(second.details).toHaveProperty('reason', 'Already traded this window');
    });
  });

  // ─── agent_hold ─────────────────────────────────────────────────────────────

  describe('cycle returns agent_hold', () => {
    it('when supervisor decides to hold', async () => {
      vi.stubGlobal(
        'fetch',
        buildFetchMock({
          '/supervisor/evaluate': () => serviceOk(mockSupervisorHold),
        }),
      );

      const result = await service.triggerOnce();

      expect(result.stage).toBe('agent_hold');
      expect(result.details).toHaveProperty('windowId', 'btc-5m-test');
      expect(result.details).toHaveProperty('reasoning', 'Uncertain regime');
    });

    it('emits agent.decision.made event on hold', async () => {
      vi.stubGlobal(
        'fetch',
        buildFetchMock({
          '/supervisor/evaluate': () => serviceOk(mockSupervisorHold),
        }),
      );

      const emitSpy = vi.spyOn(eventBus, 'emit');

      await service.triggerOnce();

      expect(emitSpy).toHaveBeenCalledWith('agent.decision.made', {
        windowId: 'btc-5m-test',
        action: 'hold',
        sizeUsd: 0,
        confidence: 0.3,
      });
    });
  });

  // ─── risk_rejected ──────────────────────────────────────────────────────────

  describe('cycle returns risk_rejected', () => {
    it('when risk service rejects the proposal', async () => {
      vi.stubGlobal(
        'fetch',
        buildFetchMock({
          '/risk/evaluate': () => serviceOk(mockRiskRejected),
        }),
      );

      const result = await service.triggerOnce();

      expect(result.stage).toBe('risk_rejected');
      expect(result.details).toHaveProperty('windowId', 'btc-5m-test');
      expect(result.details).toHaveProperty('rejectionReasons');
      expect(result.details.rejectionReasons).toContain('Max daily loss exceeded');
    });
  });

  // ─── executed ───────────────────────────────────────────────────────────────

  describe('cycle returns executed', () => {
    it('on a successful paper trade', async () => {
      vi.stubGlobal('fetch', buildFetchMock());

      const result = await service.triggerOnce();

      expect(result.stage).toBe('executed');
      expect(result.details).toHaveProperty('windowId', 'btc-5m-test');
      expect(result.details).toHaveProperty('orderId', 'order-001');
      expect(result.details).toHaveProperty('side', 'UP');
      expect(result.details).toHaveProperty('sizeUsd', 10);
      expect(result.details).toHaveProperty('mode', 'paper');
    });

    it('emits agent.decision.made event on execution', async () => {
      vi.stubGlobal('fetch', buildFetchMock());

      const emitSpy = vi.spyOn(eventBus, 'emit');

      await service.triggerOnce();

      expect(emitSpy).toHaveBeenCalledWith('agent.decision.made', {
        windowId: 'btc-5m-test',
        action: 'buy_up',
        sizeUsd: 10,
        confidence: 0.7,
      });
    });

    it('increments cycleCount after execution', async () => {
      vi.stubGlobal('fetch', buildFetchMock());

      expect(service.getStatus().cycleCount).toBe(0);

      await service.triggerOnce();

      expect(service.getStatus().cycleCount).toBe(1);
    });

    it('stores last result in status', async () => {
      vi.stubGlobal('fetch', buildFetchMock());

      await service.triggerOnce();

      const status = service.getStatus();
      expect(status.lastResult).not.toBeNull();

      const last = status.lastResult as Record<string, unknown>;
      expect(last.stage).toBe('executed');
      expect(last.cycle).toBe(1);
    });
  });

  // ─── error: agent-gateway unavailable ─────────────────────────────────────

  describe('cycle returns error', () => {
    it('when agent-gateway regime endpoint is unavailable', async () => {
      vi.stubGlobal(
        'fetch',
        buildFetchMock({
          '/regime/evaluate': () => Promise.resolve({ ok: false, status: 503 }),
          '/edge/evaluate': () => Promise.resolve({ ok: false, status: 503 }),
        }),
      );

      const result = await service.triggerOnce();

      expect(result.stage).toBe('error');
      expect(result.details).toHaveProperty('reason', 'Agent evaluation failed');
    });

    it('when agent-gateway throws a network error', async () => {
      vi.stubGlobal(
        'fetch',
        buildFetchMock({
          '/regime/evaluate': () => Promise.reject(new Error('ECONNREFUSED')),
        }),
      );

      const result = await service.triggerOnce();

      expect(result.stage).toBe('error');
      expect(result.details).toHaveProperty('reason', 'Agent evaluation failed');
    });

    it('when supervisor endpoint is unavailable', async () => {
      vi.stubGlobal(
        'fetch',
        buildFetchMock({
          '/supervisor/evaluate': () => Promise.resolve({ ok: false, status: 500 }),
        }),
      );

      const result = await service.triggerOnce();

      expect(result.stage).toBe('error');
      expect(result.details).toHaveProperty('reason', 'Supervisor evaluation failed');
    });

    it('when risk state endpoint is unavailable', async () => {
      vi.stubGlobal(
        'fetch',
        buildFetchMock({
          '/risk/state': () => Promise.resolve({ ok: false, status: 500 }),
        }),
      );

      const result = await service.triggerOnce();

      expect(result.stage).toBe('error');
      expect(result.details).toHaveProperty('reason', 'Risk service unavailable');
    });

    it('when execution endpoint fails', async () => {
      vi.stubGlobal(
        'fetch',
        buildFetchMock({
          '/paper-order': () => Promise.resolve({ ok: false, status: 500 }),
        }),
      );

      const result = await service.triggerOnce();

      expect(result.stage).toBe('error');
      expect(result.details).toHaveProperty('reason', 'Execution failed');
    });
  });

  // ─── error: dependency health check fails ─────────────────────────────────

  describe('cycle returns error on health check failure', () => {
    it('when a dependency health check returns ok=false', async () => {
      vi.stubGlobal(
        'fetch',
        buildFetchMock({
          '/agent/health': () => jsonResponse({ ok: false }),
        }),
      );

      const result = await service.triggerOnce();

      expect(result.stage).toBe('error');
      expect(result.details).toHaveProperty('reason', 'Dependency health check failed');
      expect(result.details).toHaveProperty('downServices');
      expect(result.details.downServices).toContain('agent-gateway');
    });

    it('when a dependency health endpoint throws', async () => {
      vi.stubGlobal(
        'fetch',
        buildFetchMock({
          '/features/health': () => Promise.reject(new Error('ECONNREFUSED')),
        }),
      );

      const result = await service.triggerOnce();

      expect(result.stage).toBe('error');
      expect(result.details).toHaveProperty('downServices');
      expect(result.details.downServices).toContain('feature-engine');
    });

    it('when multiple dependencies are down', async () => {
      vi.stubGlobal(
        'fetch',
        buildFetchMock({
          '/features/health': () => Promise.reject(new Error('down')),
          '/agent/health': () => Promise.reject(new Error('down')),
          '/risk/health': () => Promise.reject(new Error('down')),
          '/execution/health': () => Promise.reject(new Error('down')),
        }),
      );

      const result = await service.triggerOnce();

      expect(result.stage).toBe('error');
      const down = result.details.downServices as string[];
      expect(down).toHaveLength(4);
      expect(down).toContain('feature-engine');
      expect(down).toContain('agent-gateway');
      expect(down).toContain('risk-service');
      expect(down).toContain('execution-service');
    });
  });
});
