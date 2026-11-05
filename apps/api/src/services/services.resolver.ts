// REQ-BSM-002 REQ-BSM-006 REQ-BSM-008 — Query.services / service / incidents / incident / slas / availabilityReport /
// availabilityReportCsv, the incident-response and SLA mutations, and the ServiceHealth / Incident / Sla /
// AvailabilityPeriod / Rca field resolvers (ADR-024). Every mutation is recorded by the audit interceptor.
import { Args, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { targetFor, type IncidentSeverity } from '@openmap/bsm-engine';
import { Roles } from '../auth/roles.decorator.js';
import { ROLES } from '../auth/roles.js';
import type { CiRecord } from '../ci/ci.types.js';
import { parseInput } from '../common/validation.js';
import { IntegrationsService } from '../integrations/integrations.service.js';
import type { IntegrationView } from '../integrations/integrations.types.js';
import { TenantContext } from '../tenant/tenant.context.js';
import {
  assignIncidentArgsSchema,
  assignSlaArgsSchema,
  availabilityArgsSchema,
  idSchema,
  incidentsArgsSchema,
  reportArgsSchema,
  resolveIncidentArgsSchema,
  servicesArgsSchema,
  updateRcaArgsSchema,
  upsertSlaArgsSchema,
} from './services.schemas.js';
import { ServicesService } from './services.service.js';
import type {
  AvailabilityPeriodView,
  IncidentEventView,
  IncidentLinkRecord,
  IncidentRecord,
  RcaView,
  ServiceAvailabilityView,
  ServiceHealthView,
  SeverityTargetView,
  SlaRecord,
} from './services.types.js';

const SEVERITIES: readonly IncidentSeverity[] = ['critical', 'high', 'medium', 'low', 'informational'];

@Resolver()
export class ServicesResolver {
  constructor(
    private readonly service: ServicesService,
    private readonly tenant: TenantContext,
  ) {}

  @Query('services')
  services(@Args('health') health: unknown): Promise<ServiceHealthView[]> {
    const a = parseInput(servicesArgsSchema, { health }, 'services arguments');
    return this.service.services(this.tenant.tenantId, a.health ?? null);
  }

  @Query('service')
  service_(@Args('id') id: unknown): Promise<ServiceHealthView | null> {
    return this.service.healthViewById(this.tenant.tenantId, parseInput(idSchema, id, 'service id'));
  }

  @Query('incidents')
  incidents(@Args('open') open: unknown, @Args('serviceId') serviceId: unknown): Promise<IncidentRecord[]> {
    const a = parseInput(incidentsArgsSchema, { open, serviceId }, 'incidents arguments');
    return this.service.incidents(this.tenant.tenantId, a.open ?? true, a.serviceId ?? null);
  }

  @Query('incident')
  incident(@Args('id') id: unknown): Promise<IncidentRecord | null> {
    return this.service.incident(this.tenant.tenantId, parseInput(idSchema, id, 'incident id'));
  }

  @Query('slas')
  slas(): Promise<SlaRecord[]> {
    return this.service.slas(this.tenant.tenantId);
  }

  @Query('availabilityReport')
  availabilityReport(
    @Args('granularity') granularity: unknown,
    @Args('periods') periods: unknown,
  ): Promise<ServiceAvailabilityView[]> {
    const a = parseInput(availabilityArgsSchema, { granularity, periods }, 'availabilityReport arguments');
    return this.service.report(this.tenant.tenantId, a.granularity, a.periods ?? null);
  }

  @Query('availabilityReportCsv')
  availabilityReportCsv(
    @Args('granularity') granularity: unknown,
    @Args('periods') periods: unknown,
  ): Promise<string> {
    const a = parseInput(availabilityArgsSchema, { granularity, periods }, 'availabilityReportCsv arguments');
    return this.service.reportCsv(this.tenant.tenantId, a.granularity, a.periods ?? null);
  }

  @Mutation('acknowledgeIncident')
  @Roles(ROLES.operator)
  acknowledgeIncident(@Args('incidentId') incidentId: unknown): Promise<IncidentRecord> {
    return this.service.acknowledge(
      this.tenant.tenantId,
      this.tenant.username,
      parseInput(idSchema, incidentId, 'incident id'),
    );
  }

  @Mutation('assignIncident')
  @Roles(ROLES.operator)
  assignIncident(
    @Args('incidentId') incidentId: unknown,
    @Args('assignee') assignee: unknown,
  ): Promise<IncidentRecord> {
    const a = parseInput(assignIncidentArgsSchema, { incidentId, assignee }, 'assignIncident arguments');
    return this.service.assign(this.tenant.tenantId, this.tenant.username, a.incidentId, a.assignee);
  }

  @Mutation('resolveIncident')
  @Roles(ROLES.operator)
  resolveIncident(
    @Args('incidentId') incidentId: unknown,
    @Args('note') note: unknown,
  ): Promise<IncidentRecord> {
    const a = parseInput(resolveIncidentArgsSchema, { incidentId, note }, 'resolveIncident arguments');
    return this.service.resolve(this.tenant.tenantId, this.tenant.username, a.incidentId, a.note);
  }

  @Mutation('closeIncident')
  @Roles(ROLES.operator)
  closeIncident(@Args('incidentId') incidentId: unknown): Promise<IncidentRecord> {
    return this.service.close(
      this.tenant.tenantId,
      this.tenant.username,
      parseInput(idSchema, incidentId, 'incident id'),
    );
  }

  @Mutation('updateIncidentRca')
  @Roles(ROLES.operator)
  updateIncidentRca(
    @Args('incidentId') incidentId: unknown,
    @Args('input') input: unknown,
  ): Promise<IncidentRecord> {
    const a = parseInput(updateRcaArgsSchema, { incidentId, input }, 'updateIncidentRca arguments');
    return this.service.updateRca(this.tenant.tenantId, this.tenant.username, a.incidentId, a.input);
  }

  @Mutation('upsertSla')
  @Roles(ROLES.operator)
  upsertSla(@Args('id') id: unknown, @Args('input') input: unknown): Promise<SlaRecord> {
    const a = parseInput(upsertSlaArgsSchema, { id, input }, 'upsertSla arguments');
    return this.service.upsertSla(this.tenant.tenantId, this.tenant.username, a.id ?? null, a.input);
  }

  @Mutation('deleteSla')
  @Roles(ROLES.operator)
  deleteSla(@Args('id') id: unknown): Promise<boolean> {
    return this.service.deleteSla(
      this.tenant.tenantId,
      this.tenant.username,
      parseInput(idSchema, id, 'sla id'),
    );
  }

  @Mutation('assignSla')
  @Roles(ROLES.operator)
  assignSla(
    @Args('serviceId') serviceId: unknown,
    @Args('slaId') slaId: unknown,
  ): Promise<ServiceHealthView> {
    const a = parseInput(assignSlaArgsSchema, { serviceId, slaId }, 'assignSla arguments');
    return this.service.assignSla(this.tenant.tenantId, this.tenant.username, a.serviceId, a.slaId ?? null);
  }

  @Mutation('reportIncident')
  @Roles(ROLES.operator)
  reportIncident(
    @Args('incidentId') incidentId: unknown,
    @Args('integrationId') integrationId: unknown,
  ): Promise<IncidentLinkRecord> {
    const a = parseInput(reportArgsSchema, { incidentId, integrationId }, 'reportIncident arguments');
    return this.service.reportIncident(
      this.tenant.tenantId,
      this.tenant.username,
      a.incidentId,
      a.integrationId,
    );
  }
}

@Resolver('ServiceHealth')
export class ServiceHealthFieldsResolver {
  constructor(
    private readonly service: ServicesService,
    private readonly tenant: TenantContext,
  ) {}

  @ResolveField('availability')
  availability(
    @Parent() view: ServiceHealthView,
    @Args('granularity') granularity: unknown,
    @Args('periods') periods: unknown,
  ): Promise<AvailabilityPeriodView[]> {
    const a = parseInput(availabilityArgsSchema, { granularity, periods }, 'availability arguments');
    return this.service.availabilityOf(this.tenant.tenantId, view.service, a.granularity, a.periods ?? null);
  }
}

@Resolver('AvailabilityPeriod')
export class AvailabilityPeriodFieldsResolver {
  constructor(
    private readonly service: ServicesService,
    private readonly tenant: TenantContext,
  ) {}

  @ResolveField('incidents')
  incidents(@Parent() period: AvailabilityPeriodView): Promise<IncidentRecord[]> {
    return this.service.incidentsIn(this.tenant.tenantId, period);
  }
}

@Resolver('Sla')
export class SlaFieldsResolver {
  constructor(private readonly tenant: TenantContext) {}

  @ResolveField('responseTargets')
  responseTargets(@Parent() sla: SlaRecord): SeverityTargetView[] {
    return SEVERITIES.map((severity) => ({
      severity,
      ...targetFor({ responseTargets: sla.ownTargets }, severity),
    }));
  }

  @ResolveField('services')
  async services(@Parent() sla: SlaRecord): Promise<CiRecord[]> {
    const cis = await Promise.all(sla.serviceCiIds.map((id) => this.tenant.loaders.ci.load(id)));
    return cis.filter((c): c is CiRecord => c !== null);
  }
}

@Resolver('Incident')
export class IncidentFieldsResolver {
  constructor(
    private readonly service: ServicesService,
    private readonly tenant: TenantContext,
  ) {}

  @ResolveField('service')
  async service_(@Parent() incident: IncidentRecord): Promise<CiRecord | null> {
    return incident.serviceCiId === null ? null : this.tenant.loaders.ci.load(incident.serviceCiId);
  }

  @ResolveField('rootCause')
  rootCause(@Parent() incident: IncidentRecord): Promise<CiRecord | null> {
    return incident.rootCauseCiId === null
      ? Promise.resolve(null)
      : this.tenant.loaders.ci.load(incident.rootCauseCiId);
  }

  @ResolveField('sla')
  sla(@Parent() incident: IncidentRecord): Promise<SlaRecord | null> {
    return incident.slaId === null
      ? Promise.resolve(null)
      : this.service.sla(this.tenant.tenantId, incident.slaId);
  }

  @ResolveField('links')
  links(@Parent() incident: IncidentRecord): Promise<IncidentLinkRecord[]> {
    return this.service.links(this.tenant.tenantId, incident.id);
  }

  @ResolveField('timeline')
  timeline(@Parent() incident: IncidentRecord): Promise<IncidentEventView[]> {
    return this.service.timeline(this.tenant.tenantId, incident.id);
  }
}

@Resolver('Rca')
export class RcaFieldsResolver {
  constructor(private readonly tenant: TenantContext) {}

  @ResolveField('rootCauseCi')
  rootCauseCi(@Parent() rca: RcaView): Promise<CiRecord | null> {
    return rca.rootCauseCiId === null
      ? Promise.resolve(null)
      : this.tenant.loaders.ci.load(rca.rootCauseCiId);
  }
}

@Resolver('IncidentLink')
export class IncidentLinkFieldsResolver {
  constructor(
    private readonly integrations: IntegrationsService,
    private readonly tenant: TenantContext,
  ) {}

  @ResolveField('integration')
  integration(@Parent() link: IncidentLinkRecord): Promise<IntegrationView> {
    return this.integrations.require(this.tenant.tenantId, link.integrationId);
  }
}
