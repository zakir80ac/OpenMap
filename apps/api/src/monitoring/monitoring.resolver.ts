// REQ-INT-012 (ADR-073) — Query.monitoringAlerts, Mutation.mapMonitoringSource / clearMonitoringAlert, and the CI
// fields of MonitoringAlert and MonitoringSourceMapping.
import { Args, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { MONITORING } from '@openmap/constants';
import { MONITORING_STATUSES } from '@openmap/contracts';
import { z } from 'zod';
import { Roles } from '../auth/roles.decorator.js';
import { ROLES } from '../auth/roles.js';
import type { CiRecord } from '../ci/ci.types.js';
import { parseInput } from '../common/validation.js';
import { TenantContext } from '../tenant/tenant.context.js';
import { MonitoringService, type MonitoringAlertView, type MonitoringAlertsView, type MonitoringMappingView } from './monitoring.service.js';

const listArgs = z.object({
  status: z.enum(MONITORING_STATUSES).nullish(),
  unresolvedOnly: z.boolean().nullish(),
  first: z.number().int().positive().nullish(),
});
const mapArgs = z.object({ sourceKey: z.string().trim().min(1), ciId: z.uuid() });
const idArg = z.uuid();

@Resolver()
export class MonitoringResolver {
  constructor(
    private readonly service: MonitoringService,
    private readonly tenant: TenantContext,
  ) {}

  @Query('monitoringAlerts')
  monitoringAlerts(@Args('status') status: unknown, @Args('unresolvedOnly') unresolvedOnly: unknown, @Args('first') first: unknown): Promise<MonitoringAlertsView> {
    const a = parseInput(listArgs, { status, unresolvedOnly, first }, 'monitoringAlerts arguments');
    return this.service.list(this.tenant.tenantId, { status: a.status ?? null, unresolvedOnly: a.unresolvedOnly ?? false, first: a.first ?? MONITORING.defaultPageSize });
  }

  @Mutation('mapMonitoringSource')
  @Roles(ROLES.operator)
  mapMonitoringSource(@Args('sourceKey') sourceKey: unknown, @Args('ciId') ciId: unknown): Promise<MonitoringMappingView> {
    const a = parseInput(mapArgs, { sourceKey, ciId }, 'mapMonitoringSource arguments');
    return this.service.map(this.tenant.tenantId, this.tenant.username, a.sourceKey, a.ciId);
  }

  @Mutation('clearMonitoringAlert')
  @Roles(ROLES.operator)
  clearMonitoringAlert(@Args('id') id: unknown): Promise<MonitoringAlertView> {
    return this.service.clear(this.tenant.tenantId, this.tenant.username, parseInput(idArg, id, 'monitoring alert id'));
  }
}

@Resolver('MonitoringAlert')
export class MonitoringAlertFieldsResolver {
  constructor(private readonly tenant: TenantContext) {}

  @ResolveField('ci')
  ci(@Parent() a: MonitoringAlertView): Promise<CiRecord | null> {
    return a.ciId === null ? Promise.resolve(null) : this.tenant.loaders.ci.load(a.ciId);
  }
}

@Resolver('MonitoringSourceMapping')
export class MonitoringMappingFieldsResolver {
  constructor(private readonly tenant: TenantContext) {}

  @ResolveField('ci')
  ci(@Parent() m: MonitoringMappingView): Promise<CiRecord | null> {
    return this.tenant.loaders.ci.load(m.ciId);
  }
}
