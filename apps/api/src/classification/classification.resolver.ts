// REQ-AI-002 (ADR-052) — Query.classificationSuggestions, Mutation.acceptClassificationSuggestion /
// dismissClassificationSuggestion and ClassificationSuggestion.ci.
import { Args, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { z } from 'zod';
import { Roles } from '../auth/roles.decorator.js';
import { ROLES } from '../auth/roles.js';
import type { Actor } from '../ci/ci.service.js';
import type { CiRecord } from '../ci/ci.types.js';
import { parseInput } from '../common/validation.js';
import { TenantContext } from '../tenant/tenant.context.js';
import { ClassificationService, type ClassificationSuggestionView, type ClassificationSummaryView } from './classification.service.js';

const idArg = z.uuid();

@Resolver()
export class ClassificationResolver {
  constructor(
    private readonly service: ClassificationService,
    private readonly tenant: TenantContext,
  ) {}

  @Query('classificationSuggestions')
  classificationSuggestions(): Promise<ClassificationSummaryView> {
    return this.service.summary(this.tenant.tenantId);
  }

  @Mutation('acceptClassificationSuggestion')
  @Roles(ROLES.operator)
  acceptClassificationSuggestion(@Args('id') id: unknown): Promise<ClassificationSuggestionView> {
    return this.service.accept(this.actor(), parseInput(idArg, id, 'suggestion id'));
  }

  @Mutation('dismissClassificationSuggestion')
  @Roles(ROLES.operator)
  dismissClassificationSuggestion(@Args('id') id: unknown): Promise<ClassificationSuggestionView> {
    return this.service.dismiss(this.actor(), parseInput(idArg, id, 'suggestion id'));
  }

  private actor(): Actor {
    return { tenantId: this.tenant.tenantId, username: this.tenant.username, requestId: this.tenant.requestId };
  }
}

@Resolver('ClassificationSuggestion')
export class ClassificationSuggestionFieldsResolver {
  constructor(private readonly tenant: TenantContext) {}

  @ResolveField('ci')
  async ci(@Parent() s: ClassificationSuggestionView): Promise<CiRecord> {
    const ci = await this.tenant.loaders.ci.load(s.ciId);
    if (ci === null) throw new Error('classification suggestion ' + s.id + ' names a CI that no longer exists');
    return ci;
  }
}
