// REQ-INT-005 — Query.integrations, Mutation.upsertIntegration and Mutation.testIntegration.
import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { z } from 'zod';
import { integrationCategorySchema } from '@openmap/contracts';
import { Roles } from '../auth/roles.decorator.js';
import { ROLES } from '../auth/roles.js';
import { parseInput } from '../common/validation.js';
import { TenantContext } from '../tenant/tenant.context.js';
import { integrationInputSchema } from './integrations.schemas.js';
import { IntegrationsService } from './integrations.service.js';
import type { IntegrationView } from './integrations.types.js';

const listArgs = z.object({ category: integrationCategorySchema.nullish() });
const upsertArgs = z.object({ id: z.uuid().nullish(), input: integrationInputSchema });
const idArg = z.uuid();

@Resolver()
export class IntegrationsResolver {
  constructor(
    private readonly service: IntegrationsService,
    private readonly tenant: TenantContext,
  ) {}

  @Query('integrations')
  integrations(@Args('category') category: unknown): Promise<IntegrationView[]> {
    const a = parseInput(listArgs, { category }, 'integrations arguments');
    return this.service.list(this.tenant.tenantId, a.category ?? null);
  }

  @Mutation('upsertIntegration')
  @Roles(ROLES.admin)
  upsertIntegration(@Args('id') id: unknown, @Args('input') input: unknown): Promise<IntegrationView> {
    const a = parseInput(upsertArgs, { id, input }, 'upsertIntegration arguments');
    return this.service.upsert(this.tenant.tenantId, this.tenant.username, a.id ?? null, a.input);
  }

  @Mutation('testIntegration')
  @Roles(ROLES.admin)
  testIntegration(@Args('id') id: unknown): Promise<IntegrationView> {
    return this.service.test(this.tenant.tenantId, parseInput(idArg, id, 'integration id'));
  }
}
