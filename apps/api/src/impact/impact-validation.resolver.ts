// REQ-BSM-004 (ADR-047) — Query.impactAccuracy / relationshipSuggestions, Mutation.validateImpactPredictions /
// acceptRelationshipSuggestion / dismissRelationshipSuggestion and the ImpactValidation / RelationshipSuggestion
// field resolvers.
import { Inject } from '@nestjs/common';
import { Args, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { IMPACT } from '@openmap/constants';
import { suggestionStateSchema, type RelationshipSuggestion } from '@openmap/contracts';
import { z } from 'zod';
import { Roles } from '../auth/roles.decorator.js';
import { ROLES } from '../auth/roles.js';
import { CI_REPOSITORY, type CiRepository } from '../ci/ci.repository.js';
import type { CiRecord, RelationshipRecord } from '../ci/ci.types.js';
import { parseInput } from '../common/validation.js';
import { ServicesService } from '../services/services.service.js';
import type { IncidentRecord } from '../services/services.types.js';
import { TenantContext } from '../tenant/tenant.context.js';
import { boundedLimit, ImpactValidationService, type ImpactAccuracyView, type ImpactValidationView } from './impact-validation.service.js';
import { ImpactService } from './impact.service.js';
import type { ImpactSimulationView } from './impact.types.js';

const idArg = z.uuid();
const limitArg = z.number().int().min(1).nullish();

@Resolver()
export class ImpactValidationResolver {
  constructor(
    private readonly service: ImpactValidationService,
    private readonly tenant: TenantContext,
  ) {}

  @Query('impactAccuracy')
  impactAccuracy(@Args('limit') limit: unknown): Promise<ImpactAccuracyView> {
    return this.service.accuracy(this.tenant.tenantId, boundedLimit(parseInput(limitArg, limit, 'impactAccuracy limit'), IMPACT.recentDefault));
  }

  @Query('relationshipSuggestions')
  relationshipSuggestions(@Args('state') state: unknown, @Args('limit') limit: unknown): Promise<RelationshipSuggestion[]> {
    return this.service.suggestions(
      this.tenant.tenantId,
      parseInput(suggestionStateSchema, state ?? 'open', 'suggestion state'),
      boundedLimit(parseInput(limitArg, limit, 'relationshipSuggestions limit'), IMPACT.suggestionsDefault),
    );
  }

  @Mutation('validateImpactPredictions')
  @Roles(ROLES.operator)
  async validateImpactPredictions(@Args('limit') limit: unknown): Promise<ImpactAccuracyView> {
    const tenantId = this.tenant.tenantId;
    await this.service.validatePending(tenantId, boundedLimit(parseInput(limitArg, limit, 'validateImpactPredictions limit'), IMPACT.sweepBatch));
    return this.service.accuracy(tenantId, IMPACT.recentDefault);
  }

  @Mutation('validateImpactPrediction')
  @Roles(ROLES.operator)
  validateImpactPrediction(@Args('incidentId') incidentId: unknown): Promise<ImpactValidationView> {
    return this.service.validateIncident(this.tenant.tenantId, parseInput(idArg, incidentId, 'incident id'));
  }

  @Mutation('acceptRelationshipSuggestion')
  @Roles(ROLES.operator)
  acceptRelationshipSuggestion(@Args('id') id: unknown): Promise<RelationshipSuggestion> {
    return this.service.accept(this.actor(), parseInput(idArg, id, 'suggestion id'));
  }

  @Mutation('dismissRelationshipSuggestion')
  @Roles(ROLES.operator)
  dismissRelationshipSuggestion(@Args('id') id: unknown): Promise<RelationshipSuggestion> {
    return this.service.dismiss(this.actor(), parseInput(idArg, id, 'suggestion id'));
  }

  private actor(): { tenantId: string; username: string; requestId: string } {
    return { tenantId: this.tenant.tenantId, username: this.tenant.username, requestId: this.tenant.requestId };
  }
}

@Resolver('ImpactValidation')
export class ImpactValidationFieldsResolver {
  constructor(
    private readonly impact: ImpactService,
    private readonly services: ServicesService,
    @Inject(CI_REPOSITORY) private readonly cis: CiRepository,
    private readonly tenant: TenantContext,
  ) {}

  @ResolveField('incident')
  incident(@Parent() v: ImpactValidationView): Promise<IncidentRecord | null> {
    return this.services.incident(this.tenant.tenantId, v.incidentId);
  }

  @ResolveField('simulation')
  simulation(@Parent() v: ImpactValidationView): Promise<ImpactSimulationView | null> {
    return this.impact.simulation(this.tenant.tenantId, v.simulationId);
  }

  @ResolveField('rootCause')
  async rootCause(@Parent() v: ImpactValidationView): Promise<CiRecord | null> {
    return (await this.cis.findByIds(this.tenant.tenantId, [v.rootCauseCiId]))[0] ?? null;
  }

  @ResolveField('predictedServices')
  predictedServices(@Parent() v: ImpactValidationView): Promise<CiRecord[]> {
    return this.cis.findByIds(this.tenant.tenantId, v.predictedServiceCiIds);
  }

  @ResolveField('actualServices')
  actualServices(@Parent() v: ImpactValidationView): Promise<CiRecord[]> {
    return this.cis.findByIds(this.tenant.tenantId, v.actualServiceCiIds);
  }

  @ResolveField('missedServices')
  missedServices(@Parent() v: ImpactValidationView): Promise<CiRecord[]> {
    return this.cis.findByIds(this.tenant.tenantId, v.missedServiceCiIds);
  }

  @ResolveField('unexpectedServices')
  unexpectedServices(@Parent() v: ImpactValidationView): Promise<CiRecord[]> {
    return this.cis.findByIds(this.tenant.tenantId, v.unexpectedServiceCiIds);
  }
}

@Resolver('RelationshipSuggestion')
export class RelationshipSuggestionFieldsResolver {
  constructor(
    private readonly services: ServicesService,
    @Inject(CI_REPOSITORY) private readonly cis: CiRepository,
    private readonly tenant: TenantContext,
  ) {}

  @ResolveField('from')
  async from(@Parent() s: RelationshipSuggestion): Promise<CiRecord | null> {
    return (await this.cis.findByIds(this.tenant.tenantId, [s.fromCiId]))[0] ?? null;
  }

  @ResolveField('to')
  async to(@Parent() s: RelationshipSuggestion): Promise<CiRecord | null> {
    return (await this.cis.findByIds(this.tenant.tenantId, [s.toCiId]))[0] ?? null;
  }

  @ResolveField('lastIncident')
  lastIncident(@Parent() s: RelationshipSuggestion): Promise<IncidentRecord | null> | null {
    return s.lastIncidentId === null ? null : this.services.incident(this.tenant.tenantId, s.lastIncidentId);
  }

  @ResolveField('relationship')
  relationship(@Parent() s: RelationshipSuggestion): Promise<RelationshipRecord | null> | null {
    return s.relationshipId === null ? null : this.cis.relationshipById(this.tenant.tenantId, s.relationshipId);
  }
}
