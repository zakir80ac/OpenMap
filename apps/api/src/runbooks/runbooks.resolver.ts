// REQ-BSM-005 (ADR-048) — Query.runbooks / runbook, Mutation.upsertRunbook / deleteRunbook / setScenarioRunbook /
// setIncidentRunbook / runRunbookStep, and the runbook fields of Runbook, RunbookStepRun, ImpactScenario and Incident.
import { Args, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { runbookMinutes, type RunbookRecord, type RunbookStepRun } from '@openmap/contracts';
import { z } from 'zod';
import { Roles } from '../auth/roles.decorator.js';
import { ROLES } from '../auth/roles.js';
import { parseInput } from '../common/validation.js';
import type { ImpactScenarioView } from '../impact/impact.types.js';
import { ImpactService } from '../impact/impact.service.js';
import { IntegrationsService } from '../integrations/integrations.service.js';
import type { IntegrationView } from '../integrations/integrations.types.js';
import { ServicesService } from '../services/services.service.js';
import type { IncidentRecord } from '../services/services.types.js';
import { TenantContext } from '../tenant/tenant.context.js';
import { runbookInputSchema, runStepArgsSchema } from './runbooks.schemas.js';
import { RunbooksService, type RunbookActor } from './runbooks.service.js';

const idArg = z.uuid();
const optionalIdArg = z.uuid().nullish();

@Resolver()
export class RunbooksResolver {
  constructor(
    private readonly service: RunbooksService,
    private readonly impact: ImpactService,
    private readonly services: ServicesService,
    private readonly tenant: TenantContext,
  ) {}

  private actor(): RunbookActor {
    return { tenantId: this.tenant.tenantId, username: this.tenant.username };
  }

  @Query('runbooks')
  runbooks(): Promise<RunbookRecord[]> {
    return this.service.list(this.tenant.tenantId);
  }

  @Query('runbook')
  runbook(@Args('id') id: unknown): Promise<RunbookRecord | null> {
    return this.service.byId(this.tenant.tenantId, parseInput(idArg, id, 'runbook id'));
  }

  @Mutation('upsertRunbook')
  @Roles(ROLES.operator)
  upsertRunbook(@Args('id') id: unknown, @Args('input') input: unknown): Promise<RunbookRecord> {
    return this.service.upsert(this.actor(), parseInput(optionalIdArg, id, 'runbook id') ?? null, parseInput(runbookInputSchema, input, 'RunbookInput'));
  }

  @Mutation('deleteRunbook')
  @Roles(ROLES.operator)
  deleteRunbook(@Args('id') id: unknown): Promise<boolean> {
    return this.service.delete(this.actor(), parseInput(idArg, id, 'runbook id'));
  }

  @Mutation('setScenarioRunbook')
  @Roles(ROLES.operator)
  async setScenarioRunbook(@Args('scenarioId') scenarioId: unknown, @Args('runbookId') runbookId: unknown): Promise<ImpactScenarioView> {
    const id = parseInput(idArg, scenarioId, 'scenario id');
    await this.service.attachToScenario(this.actor(), id, parseInput(optionalIdArg, runbookId, 'runbook id') ?? null);
    return this.impact.scenario(this.tenant.tenantId, id);
  }

  @Mutation('setIncidentRunbook')
  @Roles(ROLES.operator)
  async setIncidentRunbook(@Args('incidentId') incidentId: unknown, @Args('runbookId') runbookId: unknown): Promise<IncidentRecord | null> {
    const id = parseInput(idArg, incidentId, 'incident id');
    await this.service.attachToIncident(this.actor(), id, parseInput(optionalIdArg, runbookId, 'runbook id') ?? null);
    return this.services.incident(this.tenant.tenantId, id);
  }

  @Mutation('runRunbookStep')
  @Roles(ROLES.operator)
  runRunbookStep(@Args('incidentId') incidentId: unknown, @Args('order') order: unknown, @Args('note') note: unknown): Promise<RunbookStepRun> {
    const args = parseInput(runStepArgsSchema, { incidentId, order, note }, 'runRunbookStep arguments');
    return this.service.runStep(this.actor(), args.incidentId, args.order, args.note ?? null);
  }
}

@Resolver('Runbook')
export class RunbookFieldsResolver {
  @ResolveField('estimatedMinutes')
  estimatedMinutes(@Parent() runbook: RunbookRecord): number | null {
    return runbookMinutes(runbook);
  }
}

@Resolver('RunbookAutomation')
export class RunbookAutomationFieldsResolver {
  constructor(
    private readonly integrations: IntegrationsService,
    private readonly tenant: TenantContext,
  ) {}

  @ResolveField('integration')
  async integration(@Parent() automation: { integrationId: string }): Promise<IntegrationView | null> {
    return (await this.integrations.byIds(this.tenant.tenantId, [automation.integrationId]))[0] ?? null;
  }
}

@Resolver('RunbookStepRun')
export class RunbookStepRunFieldsResolver {
  constructor(
    private readonly integrations: IntegrationsService,
    private readonly tenant: TenantContext,
  ) {}

  @ResolveField('integration')
  async integration(@Parent() run: RunbookStepRun): Promise<IntegrationView | null> {
    if (run.integrationId === null) return null;
    return (await this.integrations.byIds(this.tenant.tenantId, [run.integrationId]))[0] ?? null;
  }
}

@Resolver('ImpactScenario')
export class ScenarioRunbookFieldsResolver {
  constructor(
    private readonly service: RunbooksService,
    private readonly tenant: TenantContext,
  ) {}

  @ResolveField('runbook')
  runbook(@Parent() scenario: ImpactScenarioView): Promise<RunbookRecord | null> {
    return this.service.scenarioRunbook(this.tenant.tenantId, scenario.id);
  }
}

@Resolver('Incident')
export class IncidentRunbookFieldsResolver {
  constructor(
    private readonly service: RunbooksService,
    private readonly tenant: TenantContext,
  ) {}

  @ResolveField('runbook')
  runbook(@Parent() incident: IncidentRecord): Promise<RunbookRecord | null> {
    return this.service.incidentRunbook(this.tenant.tenantId, incident.id);
  }

  @ResolveField('suggestedRunbook')
  suggestedRunbook(@Parent() incident: IncidentRecord): Promise<RunbookRecord | null> {
    return this.service.suggestedRunbook(this.tenant.tenantId, incident.id);
  }

  @ResolveField('runbookRuns')
  runbookRuns(@Parent() incident: IncidentRecord): Promise<RunbookStepRun[]> {
    return this.service.runs(this.tenant.tenantId, incident.id);
  }

  @ResolveField('recoveryEstimateMinutes')
  async recoveryEstimateMinutes(@Parent() incident: IncidentRecord): Promise<number | null> {
    return (await this.service.recovery(this.tenant.tenantId, incident.id)).estimateMinutes;
  }

  @ResolveField('recoveryRemainingMinutes')
  async recoveryRemainingMinutes(@Parent() incident: IncidentRecord): Promise<number | null> {
    return (await this.service.recovery(this.tenant.tenantId, incident.id)).remainingMinutes;
  }
}
