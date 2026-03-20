import { Controller, Get, Post, Body, HttpCode } from '@nestjs/common';
import { ConfigManagementService } from './config-management.service';
import type { SystemConfigUpdate } from './config-management.service';

@Controller('api/v1/config')
export class ConfigManagementController {
  constructor(private readonly configManagementService: ConfigManagementService) {}

  /**
   * GET /api/v1/config
   * Returns the full effective system configuration (DB values merged with env/defaults).
   */
  @Get()
  async getConfig() {
    const config = await this.configManagementService.getEffectiveConfig();
    return { ok: true, data: config };
  }

  /**
   * POST /api/v1/config
   * Updates one or more system configuration values. Validated with Zod.
   */
  @Post()
  @HttpCode(200)
  async updateConfig(@Body() body: SystemConfigUpdate) {
    const config = await this.configManagementService.updateConfig(body);
    return { ok: true, data: config };
  }

  /**
   * GET /api/v1/config/feature-flags
   * Returns all feature flags and their current values.
   */
  @Get('feature-flags')
  async getFeatureFlags() {
    const flags = await this.configManagementService.getFeatureFlags();
    return { ok: true, data: flags };
  }
}
