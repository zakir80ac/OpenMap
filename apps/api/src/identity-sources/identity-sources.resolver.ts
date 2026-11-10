// REQ-INT-016 (ADR-074) — Query.identitySources, Mutation.upsertIdentitySource / testIdentitySource /
// syncIdentitySource / removeIdentitySource. Administrators only: a source decides who signs in and with which role.
import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { identitySourceInputSchema } from '@openmap/contracts';
import { z } from 'zod';
import { Roles } from '../auth/roles.decorator.js';
import { ROLES } from '../auth/roles.js';
import type { Actor } from '../ci/ci.service.js';
import { parseInput } from '../common/validation.js';
import { TenantContext } from '../tenant/tenant.context.js';
import {
  IdentitySourcesService,
  type IdentitySourceSyncView,
  type IdentitySourceTestView,
  type IdentitySourceView,
} from './identity-sources.service.js';

const upsertArgs = z.object({ id: z.uuid().nullish(), input: identitySourceInputSchema });
const idArg = z.uuid();

@Resolver()
export class IdentitySourcesResolver {
  constructor(
    private readonly service: IdentitySourcesService,
    private readonly tenant: TenantContext,
  ) {}

  private actor(): Actor {
    return { tenantId: this.tenant.tenantId, username: this.tenant.username, requestId: this.tenant.requestId };
  }

  @Query('identitySources')
  @Roles(ROLES.admin)
  identitySources(): Promise<IdentitySourceView[]> {
    return this.service.list(this.tenant.tenantId);
  }

  @Mutation('upsertIdentitySource')
  @Roles(ROLES.admin)
  upsertIdentitySource(@Args('id') id: unknown, @Args('input') input: unknown): Promise<IdentitySourceView> {
    const a = parseInput(upsertArgs, { id, input }, 'upsertIdentitySource arguments');
    return this.service.upsert(this.actor(), a.id ?? null, a.input);
  }

  @Mutation('testIdentitySource')
  @Roles(ROLES.admin)
  testIdentitySource(@Args('id') id: unknown): Promise<IdentitySourceTestView> {
    return this.service.test(this.actor(), parseInput(idArg, id, 'identity source id'));
  }

  @Mutation('syncIdentitySource')
  @Roles(ROLES.admin)
  syncIdentitySource(@Args('id') id: unknown): Promise<IdentitySourceSyncView> {
    return this.service.sync(this.actor(), parseInput(idArg, id, 'identity source id'));
  }

  @Mutation('removeIdentitySource')
  @Roles(ROLES.admin)
  removeIdentitySource(@Args('id') id: unknown): Promise<boolean> {
    return this.service.remove(this.actor(), parseInput(idArg, id, 'identity source id'));
  }
}
