// REQ-BSM-002 — Query.services / Query.incidents, Mutation.acknowledgeIncident / reportIncident and
// the Incident / IncidentLink field resolvers.
import { Args, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { z } from 'zod';
import { Roles } from '../auth/roles.decorator.js';
import { ROLES } from '../auth/roles.js';
import { healthStateSchema } from '../ci/ci.schemas.js';
import type { CiRecord } from '../ci/ci.types.js';
import { parseInput } from '../common/validation.js';
import { IntegrationsService } from '../integrations/integrations.service.js';
import type { IntegrationView } from '../integrations/integrations.types.js';
import { TenantContext } from '../tenant/tenant.context.js';
import { ServicesService } from './services.service.js';
import type { IncidentLinkRecord, IncidentRecord, ServiceHealthView } from './services.types.js';

const servicesArgs = z.object({ health: z.array(healthStateSchema).nullish() });
const incidentsArgs = z.object({ open: z.boolean().nullish() });
const reportArgs = z.object({ incidentId: z.uuid(), integrationId: z.uuid() });
const idArg = z.uuid();

@Resolver()
export class ServicesResolver {
  constructor(
    private readonly service: ServicesService,
    private readonly tenant: TenantContext,
  ) {}

  @Query('services')
  services(@Args('health') health: unknown): Promise<ServiceHealthView[]> {
    const a = parseInput(servicesArgs, { health }, 'services arguments');
    return this.service.services(this.tenant.tenantId, a.health ?? null);
  }

  @Query('incidents')
  incidents(@Args('open') open: unknown): Promise<IncidentRecord[]> {
    const a = parseInput(incidentsArgs, { open }, 'incidents arguments');
    return this.service.incidents(this.tenant.tenantId, a.open ?? true);
  }

  @Mutation('acknowledgeIncident')
  @Roles(ROLES.operator)
  acknowledgeIncident(@Args('incidentId') incidentId: unknown): Promise<IncidentRecord> {
    return this.service.acknowledge(this.tenant.tenantId, this.tenant.username, parseInput(idArg, incidentId, 'incident id'));
  }

  @Mutation('reportIncident')
  @Roles(ROLES.operator)
  reportIncident(@Args('incidentId') incidentId: unknown, @Args('integrationId') integrationId: unknown): Promise<IncidentLinkRecord> {
    const a = parseInput(reportArgs, { incidentId, integrationId }, 'reportIncident arguments');
    return this.service.reportIncident(this.tenant.tenantId, this.tenant.username, a.incidentId, a.integrationId);
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
    return incident.rootCauseCiId === null ? Promise.resolve(null) : this.tenant.loaders.ci.load(incident.rootCauseCiId);
  }

  @ResolveField('links')
  links(@Parent() incident: IncidentRecord): Promise<IncidentLinkRecord[]> {
    return this.service.links(this.tenant.tenantId, incident.id);
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
