import type { HttpService } from '@nestjs/axios';
import type { AxiosHeaders, AxiosResponse, InternalAxiosRequestConfig } from 'axios';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { of, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GatewayService } from './gateway.service';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeAxiosResponse<T>(data: T, status = 200): AxiosResponse<T> {
  return {
    data,
    status,
    statusText: 'OK',
    headers: {},
    config: {
      headers: {} as AxiosHeaders,
    } as InternalAxiosRequestConfig,
  };
}

function createMockHttpService() {
  return {
    get: vi.fn(),
    request: vi.fn(),
  } as unknown as HttpService;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GatewayService', () => {
  let service: GatewayService;
  let httpService: HttpService;

  beforeEach(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {
      /* noop */
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {
      /* noop */
    });
    vi.spyOn(console, 'error').mockImplementation(() => {
      /* noop */
    });

    httpService = createMockHttpService();
    service = new GatewayService(httpService);
    await service.onModuleInit();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─── aggregateHealthChecks ─────────────────────────────────────────────────

  describe('aggregateHealthChecks', () => {
    it('returns healthy when all services respond with 200', async () => {
      const getMock = vi.fn().mockReturnValue(of(makeAxiosResponse({ ok: true })));
      (httpService as unknown as Record<string, unknown>).get = getMock;

      const health = await service.aggregateHealthChecks();

      expect(health.gateway).toBe('healthy');
      expect(health.overallStatus).toBe('healthy');
      expect(health.services.length).toBe(9); // 9 services in registry
      expect(health.checkedAt).toBeDefined();

      for (const svc of health.services) {
        expect(svc.status).toBe('healthy');
        expect(svc.error).toBeNull();
        expect(svc.latencyMs).toBeGreaterThanOrEqual(0);
      }
    });

    it('returns unhealthy when any service throws (connection refused)', async () => {
      const getMock = vi.fn().mockReturnValue(throwError(() => new Error('connect ECONNREFUSED')));
      (httpService as unknown as Record<string, unknown>).get = getMock;

      const health = await service.aggregateHealthChecks();

      expect(health.overallStatus).toBe('unhealthy');
      for (const svc of health.services) {
        expect(svc.status).toBe('unhealthy');
        expect(svc.error).toContain('ECONNREFUSED');
      }
    });

    it('returns degraded when a service returns non-2xx status', async () => {
      let callCount = 0;
      const getMock = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // First service returns 500
          return of(makeAxiosResponse({ error: 'internal' }, 500));
        }
        return of(makeAxiosResponse({ ok: true }, 200));
      });
      (httpService as unknown as Record<string, unknown>).get = getMock;

      const health = await service.aggregateHealthChecks();

      expect(health.overallStatus).toBe('degraded');
      // At least one service should be degraded
      const degradedCount = health.services.filter((s) => s.status === 'degraded').length;
      expect(degradedCount).toBeGreaterThanOrEqual(1);
    });

    it('mixes unhealthy and healthy services correctly', async () => {
      let callCount = 0;
      const getMock = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount <= 2) {
          return throwError(() => new Error('timeout'));
        }
        return of(makeAxiosResponse({ ok: true }));
      });
      (httpService as unknown as Record<string, unknown>).get = getMock;

      const health = await service.aggregateHealthChecks();

      // At least some services are unhealthy, so overall should be unhealthy
      expect(health.overallStatus).toBe('unhealthy');
      const unhealthyServices = health.services.filter((s) => s.status === 'unhealthy');
      const healthyServices = health.services.filter((s) => s.status === 'healthy');
      expect(unhealthyServices.length).toBeGreaterThanOrEqual(1);
      expect(healthyServices.length).toBeGreaterThanOrEqual(1);
    });

    it('each service health entry has name, status, latencyMs, error, checkedAt', async () => {
      const getMock = vi.fn().mockReturnValue(of(makeAxiosResponse({ ok: true })));
      (httpService as unknown as Record<string, unknown>).get = getMock;

      const health = await service.aggregateHealthChecks();

      for (const svc of health.services) {
        expect(svc).toHaveProperty('name');
        expect(svc).toHaveProperty('status');
        expect(svc).toHaveProperty('latencyMs');
        expect(svc).toHaveProperty('error');
        expect(svc).toHaveProperty('checkedAt');
        expect(typeof svc.name).toBe('string');
      }
    });

    it('includes all 9 registered service names', async () => {
      const getMock = vi.fn().mockReturnValue(of(makeAxiosResponse({ ok: true })));
      (httpService as unknown as Record<string, unknown>).get = getMock;

      const health = await service.aggregateHealthChecks();

      const names = health.services.map((s) => s.name);
      expect(names).toContain('market-discovery');
      expect(names).toContain('price-feed');
      expect(names).toContain('orderbook');
      expect(names).toContain('feature-engine');
      expect(names).toContain('risk');
      expect(names).toContain('execution');
      expect(names).toContain('config');
      expect(names).toContain('agent-gateway');
      expect(names).toContain('replay');
    });

    it('gateway field is always healthy (self)', async () => {
      const getMock = vi.fn().mockReturnValue(throwError(() => new Error('all down')));
      (httpService as unknown as Record<string, unknown>).get = getMock;

      const health = await service.aggregateHealthChecks();

      // Gateway itself is always healthy even if downstream services are not
      expect(health.gateway).toBe('healthy');
    });
  });

  // ─── getSystemStatus ───────────────────────────────────────────────────────

  describe('getSystemStatus', () => {
    it('returns system status with mode, positions, dailyPnlUsd', async () => {
      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: complex test mock setup
      const getMock = vi.fn().mockImplementation((url: string) => {
        if (url.includes(':3001')) {
          return of(
            makeAxiosResponse({ ok: true, data: { marketId: 'btc-5m', status: 'active' } }),
          );
        }
        if (url.includes(':3006')) {
          return of(makeAxiosResponse({ ok: true, data: [{ side: 'buy_up', sizeUsd: 10 }] }));
        }
        if (url.includes(':3005')) {
          return of(
            makeAxiosResponse({
              ok: true,
              data: { state: { dailyPnlUsd: 12.5 } },
            }),
          );
        }
        if (url.includes(':3007')) {
          return of(
            makeAxiosResponse({
              ok: true,
              data: { trading: { mode: 'paper' } },
            }),
          );
        }
        return of(makeAxiosResponse({ ok: true, data: null }));
      });
      (httpService as unknown as Record<string, unknown>).get = getMock;

      const status = await service.getSystemStatus();

      expect(status.mode).toBe('paper');
      expect(status.dailyPnlUsd).toBe(12.5);
      expect(status.positions).toEqual([{ side: 'buy_up', sizeUsd: 10 }]);
      expect(status.activeMarket).toEqual({ marketId: 'btc-5m', status: 'active' });
      expect(status.checkedAt).toBeDefined();
    });

    it('returns defaults when all services are down', async () => {
      const getMock = vi.fn().mockReturnValue(throwError(() => new Error('ECONNREFUSED')));
      (httpService as unknown as Record<string, unknown>).get = getMock;

      const status = await service.getSystemStatus();

      expect(status.mode).toBe('unknown');
      expect(status.dailyPnlUsd).toBe(0);
      expect(status.positions).toEqual([]);
      expect(status.activeMarket).toBeNull();
      expect(status.riskState).toBeNull();
      expect(status.config).toBeNull();
    });

    it('returns empty positions array when execution service returns non-array', async () => {
      const getMock = vi.fn().mockImplementation((url: string) => {
        if (url.includes(':3006')) {
          // Returns a non-array data value
          return of(makeAxiosResponse({ ok: true, data: 'not-an-array' }));
        }
        return of(makeAxiosResponse({ ok: true, data: {} }));
      });
      (httpService as unknown as Record<string, unknown>).get = getMock;

      const status = await service.getSystemStatus();

      expect(Array.isArray(status.positions)).toBe(true);
      expect(status.positions).toEqual([]);
    });

    it('returns checkedAt as valid ISO timestamp', async () => {
      const getMock = vi.fn().mockReturnValue(throwError(() => new Error('down')));
      (httpService as unknown as Record<string, unknown>).get = getMock;

      const status = await service.getSystemStatus();

      const date = new Date(status.checkedAt);
      expect(date.toISOString()).toBe(status.checkedAt);
    });

    it('handles partial service availability', async () => {
      const getMock = vi.fn().mockImplementation((url: string) => {
        if (url.includes(':3007')) {
          return of(
            makeAxiosResponse({
              ok: true,
              data: { trading: { mode: 'live' } },
            }),
          );
        }
        // Everything else is down
        return throwError(() => new Error('timeout'));
      });
      (httpService as unknown as Record<string, unknown>).get = getMock;

      const status = await service.getSystemStatus();

      expect(status.mode).toBe('live');
      expect(status.activeMarket).toBeNull();
      expect(status.positions).toEqual([]);
      expect(status.riskState).toBeNull();
    });
  });

  // ─── proxy ─────────────────────────────────────────────────────────────────

  describe('proxy', () => {
    it('forwards request to the correct downstream URL', async () => {
      const requestMock = vi.fn().mockReturnValue(of(makeAxiosResponse({ result: 'ok' }, 200)));
      (httpService as unknown as Record<string, unknown>).request = requestMock;

      const mockReq = {
        url: '/api/v1/agent/traces',
        method: 'GET',
        body: undefined,
        headers: { 'content-type': 'application/json' },
        ip: '127.0.0.1',
      } as unknown as FastifyRequest;

      const mockRes = {
        status: vi.fn().mockReturnThis(),
        send: vi.fn(),
      } as unknown as FastifyReply;

      await service.proxy(mockReq, mockRes, 'agent-gateway', 3008);

      expect(requestMock).toHaveBeenCalledOnce();
      const callArgs = requestMock.mock.calls[0]?.[0];
      expect(callArgs.url).toBe('http://localhost:3008/api/v1/agent/traces');
      expect(callArgs.method).toBe('get');
    });

    it('forwards response status and data to client', async () => {
      const requestMock = vi.fn().mockReturnValue(of(makeAxiosResponse({ data: [1, 2, 3] }, 201)));
      (httpService as unknown as Record<string, unknown>).request = requestMock;

      const mockReq = {
        url: '/api/v1/test',
        method: 'POST',
        body: { foo: 'bar' },
        headers: { 'content-type': 'application/json' },
        ip: '10.0.0.1',
      } as unknown as FastifyRequest;

      const mockRes = {
        status: vi.fn().mockReturnThis(),
        send: vi.fn(),
      } as unknown as FastifyReply;

      await service.proxy(mockReq, mockRes, 'test-service', 3099);

      expect(mockRes.status).toHaveBeenCalledWith(201);
      expect(mockRes.send).toHaveBeenCalledWith({ data: [1, 2, 3] });
    });

    it('sends request body for POST requests', async () => {
      const requestMock = vi.fn().mockReturnValue(of(makeAxiosResponse({ ok: true })));
      (httpService as unknown as Record<string, unknown>).request = requestMock;

      const requestBody = { windowId: 'win-001', features: {} };
      const mockReq = {
        url: '/api/v1/agent/regime/evaluate',
        method: 'POST',
        body: requestBody,
        headers: { 'content-type': 'application/json' },
        ip: '127.0.0.1',
      } as unknown as FastifyRequest;

      const mockRes = {
        status: vi.fn().mockReturnThis(),
        send: vi.fn(),
      } as unknown as FastifyReply;

      await service.proxy(mockReq, mockRes, 'agent-gateway', 3008);

      const callArgs = requestMock.mock.calls[0]?.[0];
      expect(callArgs.data).toEqual(requestBody);
      expect(callArgs.method).toBe('post');
    });

    it('returns 502 when downstream service is unreachable', async () => {
      const requestMock = vi
        .fn()
        .mockReturnValue(throwError(() => new Error('connect ECONNREFUSED 127.0.0.1:3008')));
      (httpService as unknown as Record<string, unknown>).request = requestMock;

      const mockReq = {
        url: '/api/v1/test',
        method: 'GET',
        body: undefined,
        headers: {},
        ip: '127.0.0.1',
      } as unknown as FastifyRequest;

      const mockRes = {
        status: vi.fn().mockReturnThis(),
        send: vi.fn(),
      } as unknown as FastifyReply;

      await service.proxy(mockReq, mockRes, 'agent-gateway', 3008);

      expect(mockRes.status).toHaveBeenCalledWith(502);
      expect(mockRes.send).toHaveBeenCalledWith(
        expect.objectContaining({
          ok: false,
          error: 'Service agent-gateway unavailable',
        }),
      );
    });

    it('includes gateway headers in forwarded request', async () => {
      const requestMock = vi.fn().mockReturnValue(of(makeAxiosResponse({ ok: true })));
      (httpService as unknown as Record<string, unknown>).request = requestMock;

      const mockReq = {
        url: '/api/v1/test',
        method: 'GET',
        body: undefined,
        headers: { 'content-type': 'application/json' },
        ip: '192.168.1.10',
      } as unknown as FastifyRequest;

      const mockRes = {
        status: vi.fn().mockReturnThis(),
        send: vi.fn(),
      } as unknown as FastifyReply;

      await service.proxy(mockReq, mockRes, 'some-service', 3001);

      const callArgs = requestMock.mock.calls[0]?.[0];
      expect(callArgs.headers['x-gateway-service']).toBe('api-gateway');
      expect(callArgs.headers['x-forwarded-for']).toBe('192.168.1.10');
    });

    it('defaults content-type to application/json when not provided', async () => {
      const requestMock = vi.fn().mockReturnValue(of(makeAxiosResponse({ ok: true })));
      (httpService as unknown as Record<string, unknown>).request = requestMock;

      const mockReq = {
        url: '/api/v1/test',
        method: 'GET',
        body: undefined,
        headers: {},
        ip: '127.0.0.1',
      } as unknown as FastifyRequest;

      const mockRes = {
        status: vi.fn().mockReturnThis(),
        send: vi.fn(),
      } as unknown as FastifyReply;

      await service.proxy(mockReq, mockRes, 'service', 3001);

      const callArgs = requestMock.mock.calls[0]?.[0];
      expect(callArgs.headers['content-type']).toBe('application/json');
    });

    it('sets 30s timeout on proxied requests', async () => {
      const requestMock = vi.fn().mockReturnValue(of(makeAxiosResponse({ ok: true })));
      (httpService as unknown as Record<string, unknown>).request = requestMock;

      const mockReq = {
        url: '/api/v1/test',
        method: 'GET',
        body: undefined,
        headers: {},
        ip: '127.0.0.1',
      } as unknown as FastifyRequest;

      const mockRes = {
        status: vi.fn().mockReturnThis(),
        send: vi.fn(),
      } as unknown as FastifyReply;

      await service.proxy(mockReq, mockRes, 'service', 3001);

      const callArgs = requestMock.mock.calls[0]?.[0];
      expect(callArgs.timeout).toBe(30_000);
    });

    it('502 error response includes detail message', async () => {
      const requestMock = vi.fn().mockReturnValue(throwError(() => new Error('socket hang up')));
      (httpService as unknown as Record<string, unknown>).request = requestMock;

      const mockReq = {
        url: '/api/v1/test',
        method: 'GET',
        body: undefined,
        headers: {},
        ip: '127.0.0.1',
      } as unknown as FastifyRequest;

      const mockRes = {
        status: vi.fn().mockReturnThis(),
        send: vi.fn(),
      } as unknown as FastifyReply;

      await service.proxy(mockReq, mockRes, 'risk', 3005);

      const sentBody = (mockRes.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
      expect(sentBody.detail).toBe('socket hang up');
      expect(sentBody.error).toBe('Service risk unavailable');
    });
  });

  // ─── onModuleInit ──────────────────────────────────────────────────────────

  describe('onModuleInit', () => {
    it('initializes without error', async () => {
      const freshService = new GatewayService(httpService);
      await expect(freshService.onModuleInit()).resolves.toBeUndefined();
    });
  });
});
