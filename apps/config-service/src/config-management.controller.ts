import { Body, Controller, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { ConfigManagementService } from './config-management.service';
import type { SystemConfigUpdate } from './config-management.service';
import { StrategyService } from './strategy.service';

@Controller('api/v1/config')
export class ConfigManagementController {
  constructor(
    @Inject(ConfigManagementService) private readonly configManagementService: ConfigManagementService,
    @Inject(StrategyService) private readonly strategyService: StrategyService,
  ) {}

  /**
   * GET /api/v1/config/health
   * Returns health status of the config service.
   */
  @Get('health')
  getHealth() {
    return {
      ok: true,
      service: 'config',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    };
  }

  @Get()
  async getConfig() {
    const config = await this.configManagementService.getEffectiveConfig();
    return { ok: true, data: config };
  }

  @Post()
  @HttpCode(200)
  async updateConfig(@Body() body: SystemConfigUpdate) {
    const config = await this.configManagementService.updateConfig(body);
    return { ok: true, data: config };
  }

  @Get('market')
  async getMarketConfig() {
    const market = await this.configManagementService.getMarketConfig();
    return { ok: true, data: market };
  }

  @Post('market')
  @HttpCode(200)
  async updateMarketConfig(@Body() body: Record<string, unknown>) {
    const market = await this.configManagementService.updateMarketConfig(body);
    return { ok: true, data: market };
  }

  @Post('reset-defaults')
  @HttpCode(200)
  async resetDefaults() {
    const config = await this.configManagementService.resetDefaults();
    return { ok: true, data: config };
  }

  @Get('feature-flags')
  async getFeatureFlags() {
    const flags = await this.configManagementService.getFeatureFlags();
    return { ok: true, data: flags };
  }

  @Get('export')
  async exportAll() {
    const config = await this.configManagementService.getConfig();
    const strategies = await this.strategyService.listStrategies();
    const strategyDetails = await Promise.all(
      (strategies ?? []).map(async (s: Record<string, unknown>) => {
        const versions = await this.strategyService.listVersions(s.id as string).catch(() => []);
        return { ...s, versions };
      }),
    );
    return {
      ok: true,
      data: {
        exportedAt: new Date().toISOString(),
        config,
        strategies: strategyDetails,
      },
    };
  }

  // ─── Strategy Endpoints ──────────────────────────────────────────────────

  @Get('strategy')
  async getActiveStrategy() {
    const strategy = await this.strategyService.getActiveStrategy();
    return { ok: true, data: strategy };
  }

  @Post('strategy')
  @HttpCode(200)
  async switchStrategy(@Body() body: { marketConfigId: string; strategyVersionId: string }) {
    await this.strategyService.switchStrategy(body.marketConfigId, body.strategyVersionId);
    const strategy = await this.strategyService.getActiveStrategy(body.marketConfigId);
    return { ok: true, data: strategy };
  }

  @Post('strategy/reset-default')
  @HttpCode(200)
  async resetDefaultStrategy() {
    const strategy = await this.strategyService.resetToDefault();
    return { ok: true, data: strategy };
  }
}

@Controller('api/v1/strategies')
export class StrategyController {
  constructor(@Inject(StrategyService) private readonly strategyService: StrategyService) {}

  @Get()
  async listStrategies() {
    const data = await this.strategyService.listStrategies();
    return { ok: true, data };
  }

  @Get(':strategyId')
  async getStrategy(@Param('strategyId') strategyId: string) {
    const data = await this.strategyService.getStrategy(strategyId);
    return { ok: true, data };
  }

  @Get(':strategyId/versions')
  async listVersions(@Param('strategyId') strategyId: string) {
    const data = await this.strategyService.listVersions(strategyId);
    return { ok: true, data };
  }

  @Post()
  async createStrategy(@Body() body: { key: string; name: string; description: string }) {
    const data = await this.strategyService.createStrategy(body);
    return { ok: true, data };
  }

  @Post(':strategyId/versions')
  async createVersion(
    @Param('strategyId') strategyId: string,
    @Body() body: { config: unknown },
  ) {
    const data = await this.strategyService.createVersion(strategyId, body.config);
    return { ok: true, data };
  }

  @Post(':strategyId/deactivate')
  @HttpCode(200)
  async deactivateStrategy(@Param('strategyId') strategyId: string) {
    const data = await this.strategyService.deactivateStrategy(strategyId);
    return { ok: true, data };
  }

  @Post('assign')
  @HttpCode(200)
  async assignStrategy(@Body() body: { marketConfigId: string; strategyVersionId: string }) {
    await this.strategyService.switchStrategy(body.marketConfigId, body.strategyVersionId);
    return { ok: true };
  }

  @Get('versions/:versionId')
  async getVersion(@Param('versionId') versionId: string) {
    const data = await this.strategyService.getVersion(versionId);
    return { ok: true, data };
  }
}
