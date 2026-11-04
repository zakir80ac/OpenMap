// REQ-UI-030 — Query.dashboards / estateStats and the dashboard mutations (ADR-020). Every signed-in role owns its
// dashboards; sharing makes one readable by the tenant. Inputs are validated with the contract schema.
import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { dashboardInputSchema } from '@openmap/contracts';
import { z } from 'zod';
import { parseInput } from '../common/validation.js';
import { TenantContext } from '../tenant/tenant.context.js';
import { DashboardsService } from './dashboards.service.js';
import type { DashboardView, EstateStatsView } from './dashboards.types.js';
import { EstateStatsService } from './estate-stats.service.js';

const idArg = z.uuid();

@Resolver()
export class DashboardsResolver {
  constructor(
    private readonly dashboards: DashboardsService,
    private readonly stats: EstateStatsService,
    private readonly tenant: TenantContext,
  ) {}

  @Query('dashboards')
  list(): Promise<DashboardView[]> {
    return this.dashboards.list(this.tenant.tenantId, this.tenant.username);
  }

  @Query('estateStats')
  estateStats(): Promise<EstateStatsView> {
    return this.stats.stats(this.tenant.tenantId);
  }

  @Mutation('createDashboard')
  create(@Args('input') input: unknown): Promise<DashboardView> {
    return this.dashboards.create(this.tenant.tenantId, this.tenant.username, parseInput(dashboardInputSchema, input, 'DashboardInput'));
  }

  @Mutation('updateDashboard')
  update(@Args('id') id: unknown, @Args('input') input: unknown): Promise<DashboardView> {
    return this.dashboards.update(this.tenant.tenantId, this.tenant.username, parseInput(idArg, id, 'dashboard id'), parseInput(dashboardInputSchema, input, 'DashboardInput'));
  }

  @Mutation('deleteDashboard')
  remove(@Args('id') id: unknown): Promise<boolean> {
    return this.dashboards.remove(this.tenant.tenantId, this.tenant.username, parseInput(idArg, id, 'dashboard id'));
  }

  @Mutation('setDefaultDashboard')
  setDefault(@Args('id') id: unknown): Promise<DashboardView> {
    return this.dashboards.setDefault(this.tenant.tenantId, this.tenant.username, parseInput(idArg, id, 'dashboard id'));
  }
}
