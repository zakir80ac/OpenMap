// REQ-BSM-003 — Query.impactScenarios / impactSimulation, Mutation.saveScenario / runSimulation and the
// ImpactScenario / ImpactSimulation field resolvers.
import { Args, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { z } from 'zod';
import { Roles } from '../auth/roles.decorator.js';
import { ROLES } from '../auth/roles.js';
import type { CiRecord } from '../ci/ci.types.js';
import { parseInput } from '../common/validation.js';
import { TenantContext } from '../tenant/tenant.context.js';
import { scenarioInputSchema } from './impact.schemas.js';
import { ImpactService } from './impact.service.js';
import type { ImpactScenarioView, ImpactSimulationView } from './impact.types.js';

const idArg = z.uuid();

@Resolver()
export class ImpactResolver {
  constructor(
    private readonly service: ImpactService,
    private readonly tenant: TenantContext,
  ) {}

  @Query('impactScenarios')
  impactScenarios(): Promise<ImpactScenarioView[]> {
    return this.service.scenarios(this.tenant.tenantId);
  }

  @Query('impactSimulation')
  impactSimulation(@Args('id') id: unknown): Promise<ImpactSimulationView | null> {
    return this.service.simulation(this.tenant.tenantId, parseInput(idArg, id, 'simulation id'));
  }

  @Mutation('saveScenario')
  @Roles(ROLES.operator)
  saveScenario(@Args('input') input: unknown): Promise<ImpactScenarioView> {
    return this.service.saveScenario(this.tenant.tenantId, this.tenant.username, parseInput(scenarioInputSchema, input, 'ScenarioInput'));
  }

  @Mutation('runSimulation')
  @Roles(ROLES.operator)
  runSimulation(@Args('scenarioId') scenarioId: unknown): Promise<ImpactSimulationView> {
    return this.service.runSimulation(this.tenant.tenantId, this.tenant.username, parseInput(idArg, scenarioId, 'scenario id'));
  }
}

@Resolver('ImpactScenario')
export class ImpactScenarioFieldsResolver {
  constructor(
    private readonly service: ImpactService,
    private readonly tenant: TenantContext,
  ) {}

  @ResolveField('failedCis')
  failedCis(@Parent() scenario: ImpactScenarioView): Promise<CiRecord[]> {
    return this.service.cisByIds(this.tenant.tenantId, scenario.failedCiIds);
  }
}

@Resolver('ImpactSimulation')
export class ImpactSimulationFieldsResolver {
  constructor(
    private readonly service: ImpactService,
    private readonly tenant: TenantContext,
  ) {}

  @ResolveField('scenario')
  scenario(@Parent() sim: ImpactSimulationView): Promise<ImpactScenarioView> {
    return this.service.scenario(this.tenant.tenantId, sim.scenarioId);
  }

  @ResolveField('failedCis')
  failedCis(@Parent() sim: ImpactSimulationView): Promise<CiRecord[]> {
    return this.service.cisByIds(this.tenant.tenantId, sim.failedCiIds);
  }

  @ResolveField('affectedApplications')
  affectedApplications(@Parent() sim: ImpactSimulationView): Promise<CiRecord[]> {
    return this.service.cisByIds(this.tenant.tenantId, sim.affectedApplicationCiIds);
  }
}
