import { createHash } from 'node:crypto';
import {
  DATABASE_CLIENT,
  type DbClient,
  marketConfigs,
  strategies,
  strategyAssignments,
  strategyVersions,
} from '@brain/database';
import { StrategyVersionConfigSchema } from '@brain/schemas';
import type { ActiveStrategyContext, StrategyVersionConfig } from '@brain/types';
import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';

@Injectable()
export class StrategyService {
  constructor(@Inject(DATABASE_CLIENT) private readonly db: DbClient) {}

  /**
   * Returns the active strategy for the given market config (or default market config).
   */
  async getActiveStrategy(marketConfigId?: string): Promise<ActiveStrategyContext | null> {
    // Resolve market config
    let resolvedMarketConfigId = marketConfigId;
    if (!resolvedMarketConfigId) {
      const defaults = await this.db
        .select()
        .from(marketConfigs)
        .where(eq(marketConfigs.isActive, true))
        .limit(1);
      if (defaults.length === 0) return null;
      resolvedMarketConfigId = defaults[0]!.id;
    }

    // Find active assignment
    const assignments = await this.db
      .select()
      .from(strategyAssignments)
      .where(
        and(
          eq(strategyAssignments.marketConfigId, resolvedMarketConfigId),
          eq(strategyAssignments.isActive, true),
        ),
      )
      .orderBy(desc(strategyAssignments.priority))
      .limit(1);

    if (assignments.length === 0) return null;

    const assignment = assignments[0]!;

    // Load version
    const versions = await this.db
      .select()
      .from(strategyVersions)
      .where(eq(strategyVersions.id, assignment.strategyVersionId))
      .limit(1);

    if (versions.length === 0) return null;

    const version = versions[0]!;

    // Load strategy identity
    const strats = await this.db
      .select()
      .from(strategies)
      .where(eq(strategies.id, version.strategyId))
      .limit(1);

    if (strats.length === 0) return null;

    const strategy = strats[0]!;
    const config = version.configJson as unknown as StrategyVersionConfig;

    return {
      strategyKey: strategy.key,
      version: version.version,
      decisionPolicy: config.decisionPolicy,
      filters: config.filters,
      riskProfile: config.riskProfile,
      executionPolicy: config.executionPolicy,
      agentProfile: config.agentProfile,
    };
  }

  /**
   * Switches the active strategy assignment for a market config.
   */
  async switchStrategy(
    marketConfigId: string,
    strategyVersionId: string,
  ): Promise<void> {
    // Verify version exists
    const versions = await this.db
      .select()
      .from(strategyVersions)
      .where(eq(strategyVersions.id, strategyVersionId))
      .limit(1);

    if (versions.length === 0) {
      throw new HttpException('Strategy version not found', HttpStatus.NOT_FOUND);
    }

    // Verify market config exists
    const configs = await this.db
      .select()
      .from(marketConfigs)
      .where(eq(marketConfigs.id, marketConfigId))
      .limit(1);

    if (configs.length === 0) {
      throw new HttpException('Market config not found', HttpStatus.NOT_FOUND);
    }

    // Deactivate existing assignments for this market config
    await this.db
      .update(strategyAssignments)
      .set({ isActive: false, updatedAt: new Date().toISOString() })
      .where(eq(strategyAssignments.marketConfigId, marketConfigId));

    // Create new active assignment
    await this.db.insert(strategyAssignments).values({
      marketConfigId,
      strategyVersionId,
      priority: 0,
      isActive: true,
    });
  }

  /**
   * Resets assignment to the default seeded strategy.
   */
  async resetToDefault(): Promise<ActiveStrategyContext | null> {
    // Find default strategy
    const defaultStrats = await this.db
      .select()
      .from(strategies)
      .where(eq(strategies.isDefault, true))
      .limit(1);

    if (defaultStrats.length === 0) {
      throw new HttpException('No default strategy found', HttpStatus.NOT_FOUND);
    }

    // Find latest version of default strategy
    const versions = await this.db
      .select()
      .from(strategyVersions)
      .where(eq(strategyVersions.strategyId, defaultStrats[0]!.id))
      .orderBy(desc(strategyVersions.version))
      .limit(1);

    if (versions.length === 0) {
      throw new HttpException('No versions for default strategy', HttpStatus.NOT_FOUND);
    }

    // Find default market config
    const defaultConfigs = await this.db
      .select()
      .from(marketConfigs)
      .where(eq(marketConfigs.isActive, true))
      .limit(1);

    if (defaultConfigs.length === 0) {
      throw new HttpException('No active market config found', HttpStatus.NOT_FOUND);
    }

    const marketConfigId = defaultConfigs[0]!.id;
    const versionId = versions[0]!.id;

    await this.switchStrategy(marketConfigId, versionId);

    return this.getActiveStrategy(marketConfigId);
  }

  /**
   * Lists all strategies.
   */
  async listStrategies() {
    return this.db.select().from(strategies);
  }

  /**
   * Gets a strategy by ID.
   */
  async getStrategy(strategyId: string) {
    const rows = await this.db
      .select()
      .from(strategies)
      .where(eq(strategies.id, strategyId))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Lists versions for a strategy.
   */
  async listVersions(strategyId: string) {
    return this.db
      .select()
      .from(strategyVersions)
      .where(eq(strategyVersions.strategyId, strategyId))
      .orderBy(desc(strategyVersions.version));
  }

  /**
   * Gets a specific version.
   */
  async getVersion(versionId: string) {
    const rows = await this.db
      .select()
      .from(strategyVersions)
      .where(eq(strategyVersions.id, versionId))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Creates a new strategy identity.
   */
  async createStrategy(input: {
    key: string;
    name: string;
    description: string;
  }) {
    const [row] = await this.db
      .insert(strategies)
      .values({
        key: input.key,
        name: input.name,
        description: input.description,
        status: 'active',
        isDefault: false,
      })
      .returning();
    return row;
  }

  /**
   * Creates a new immutable version for a strategy.
   */
  async createVersion(strategyId: string, config: unknown) {
    // Validate config
    const parsed = StrategyVersionConfigSchema.safeParse(config);
    if (!parsed.success) {
      throw new HttpException(
        {
          message: 'Invalid strategy version config',
          errors: parsed.error.issues.map((i) => ({
            path: i.path.join('.'),
            message: i.message,
          })),
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    // Verify strategy exists
    const strats = await this.db
      .select()
      .from(strategies)
      .where(eq(strategies.id, strategyId))
      .limit(1);

    if (strats.length === 0) {
      throw new HttpException('Strategy not found', HttpStatus.NOT_FOUND);
    }

    // Determine next version number
    const existing = await this.db
      .select()
      .from(strategyVersions)
      .where(eq(strategyVersions.strategyId, strategyId))
      .orderBy(desc(strategyVersions.version))
      .limit(1);

    const nextVersion = existing.length > 0 ? existing[0]!.version + 1 : 1;
    const checksum = createHash('sha256')
      .update(JSON.stringify(parsed.data))
      .digest('hex');

    const [row] = await this.db
      .insert(strategyVersions)
      .values({
        strategyId,
        version: nextVersion,
        configJson: parsed.data as unknown as Record<string, unknown>,
        checksum,
      })
      .returning();

    return row;
  }

  /**
   * Deactivates a strategy.
   */
  async deactivateStrategy(strategyId: string) {
    const rows = await this.db
      .update(strategies)
      .set({ status: 'inactive', updatedAt: new Date().toISOString() })
      .where(eq(strategies.id, strategyId))
      .returning();

    if (rows.length === 0) {
      throw new HttpException('Strategy not found', HttpStatus.NOT_FOUND);
    }

    return rows[0];
  }
}
