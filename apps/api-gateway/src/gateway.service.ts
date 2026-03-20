import { Injectable, OnModuleInit } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { FastifyRequest, FastifyReply } from 'fastify';
import { firstValueFrom } from 'rxjs';
import type { HealthStatus, ServiceName } from '@brain/types';

// ─── Service Registry ────────────────────────────────────────────────────────

interface ServiceEndpoint {
  name: ServiceName;
  port: number;
  host: string;
  healthPath: string;
}

const SERVICE_REGISTRY: ServiceEndpoint[] = [
  { name: 'market-discovery', port: 3001, host: 'localhost', healthPath: '/api/v1/market/active' },
  { name: 'price-feed', port: 3002, host: 'localhost', healthPath: '/api/v1/prices/latest' },
  { name: 'orderbook', port: 3003, host: 'localhost', healthPath: '/api/v1/orderbook/snapshot' },
  { name: 'feature-engine', port: 3004, host: 'localhost', healthPath: '/api/v1/features/latest' },
  { name: 'risk', port: 3005, host: 'localhost', healthPath: '/api/v1/risk/state' },
  { name: 'execution', port: 3006, host: 'localhost', healthPath: '/api/v1/execution/positions' },
  { name: 'config', port: 3007, host: 'localhost', healthPath: '/api/v1/config' },
  { name: 'agent-gateway', port: 3008, host: 'localhost', healthPath: '/api/v1/agent/traces?limit=1' },
  { name: 'replay', port: 3009, host: 'localhost', healthPath: '/api/v1/replay/summary' },
];

// ─── Types ───────────────────────────────────────────────────────────────────

interface ServiceHealth {
  name: ServiceName;
  status: HealthStatus;
  latencyMs: number;
  error: string | null;
  checkedAt: string;
}

interface AggregatedHealth {
  gateway: HealthStatus;
  services: ServiceHealth[];
  overallStatus: HealthStatus;
  checkedAt: string;
}

interface SystemStatus {
  mode: string;
  activeMarket: Record<string, unknown> | null;
  positions: Record<string, unknown>[];
  dailyPnlUsd: number;
  riskState: Record<string, unknown> | null;
  config: Record<string, unknown> | null;
  checkedAt: string;
}

@Injectable()
export class GatewayService implements OnModuleInit {
  constructor(private readonly httpService: HttpService) {}

  async onModuleInit(): Promise<void> {
    console.log('[api-gateway] initialized, proxying to', SERVICE_REGISTRY.length, 'services');
  }

  // ─── Health Check ──────────────────────────────────────────────────────────

  /**
   * Pings all registered services and aggregates their health status.
   */
  async aggregateHealthChecks(): Promise<AggregatedHealth> {
    const checks = await Promise.all(
      SERVICE_REGISTRY.map((svc) => this.checkServiceHealth(svc)),
    );

    const unhealthy = checks.filter((c) => c.status === 'unhealthy').length;
    const degraded = checks.filter((c) => c.status === 'degraded').length;

    let overallStatus: HealthStatus = 'healthy';
    if (unhealthy > 0) overallStatus = 'unhealthy';
    else if (degraded > 0) overallStatus = 'degraded';

    return {
      gateway: 'healthy',
      services: checks,
      overallStatus,
      checkedAt: new Date().toISOString(),
    };
  }

  /**
   * Gathers status from key services to build a system-wide overview.
   */
  async getSystemStatus(): Promise<SystemStatus> {
    const [activeMarket, positions, riskState, config] = await Promise.all([
      this.fetchFromService<Record<string, unknown>>('localhost', 3001, '/api/v1/market/active'),
      this.fetchFromService<Record<string, unknown>[]>('localhost', 3006, '/api/v1/execution/positions'),
      this.fetchFromService<Record<string, unknown>>('localhost', 3005, '/api/v1/risk/state'),
      this.fetchFromService<Record<string, unknown>>('localhost', 3007, '/api/v1/config'),
    ]);

    const mode = (config?.['trading'] as Record<string, unknown> | undefined)?.['mode'] as string ?? 'unknown';
    const dailyPnlUsd = (riskState?.['state'] as Record<string, unknown> | undefined)?.['dailyPnlUsd'] as number ?? 0;

    return {
      mode,
      activeMarket: activeMarket ?? null,
      positions: Array.isArray(positions) ? positions : [],
      dailyPnlUsd,
      riskState: riskState ?? null,
      config: config ?? null,
      checkedAt: new Date().toISOString(),
    };
  }

  // ─── Proxy ─────────────────────────────────────────────────────────────────

  /**
   * Proxies an incoming request to a downstream service.
   */
  async proxy(
    req: FastifyRequest,
    res: FastifyReply,
    serviceName: string,
    port: number,
  ): Promise<void> {
    const url = `http://localhost:${port}${req.url}`;
    const method = req.method.toLowerCase();

    try {
      const response = await firstValueFrom(
        this.httpService.request({
          method,
          url,
          data: req.body,
          headers: {
            'content-type': req.headers['content-type'] ?? 'application/json',
            'x-forwarded-for': req.ip,
            'x-gateway-service': 'api-gateway',
          },
          timeout: 30_000,
          validateStatus: () => true, // Forward all status codes
        }),
      );

      res.status(response.status).send(response.data);
    } catch (error) {
      const message = (error as Error).message;
      console.error(`[api-gateway] Proxy error → ${serviceName} (${url}):`, message);

      res.status(502).send({
        ok: false,
        error: `Service ${serviceName} unavailable`,
        detail: message,
      });
    }
  }

  // ─── Internal Helpers ──────────────────────────────────────────────────────

  private async checkServiceHealth(svc: ServiceEndpoint): Promise<ServiceHealth> {
    const startMs = Date.now();

    try {
      const url = `http://${svc.host}:${svc.port}${svc.healthPath}`;
      const response = await firstValueFrom(
        this.httpService.get(url, { timeout: 5_000, validateStatus: () => true }),
      );

      const latencyMs = Date.now() - startMs;
      const isOk = response.status >= 200 && response.status < 400;

      return {
        name: svc.name,
        status: isOk ? (latencyMs > 2000 ? 'degraded' : 'healthy') : 'degraded',
        latencyMs,
        error: isOk ? null : `HTTP ${response.status}`,
        checkedAt: new Date().toISOString(),
      };
    } catch (error) {
      return {
        name: svc.name,
        status: 'unhealthy',
        latencyMs: Date.now() - startMs,
        error: (error as Error).message,
        checkedAt: new Date().toISOString(),
      };
    }
  }

  private async fetchFromService<T>(host: string, port: number, path: string): Promise<T | null> {
    try {
      const url = `http://${host}:${port}${path}`;
      const response = await firstValueFrom(
        this.httpService.get<{ ok: boolean; data: T }>(url, { timeout: 5_000 }),
      );

      if (response.data?.ok) {
        return response.data.data;
      }
      return null;
    } catch {
      return null;
    }
  }
}
