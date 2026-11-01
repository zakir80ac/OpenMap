// REQ-DISC-029 — Query.discoveryNodes / discoveryJobs / currentSweep / discoveryScopes, Mutation.runDiscovery /
// updateDiscoveryScope and the DiscoveryNode / DiscoveryJob / DiscoveryScope field resolvers.
import { Args, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { z } from 'zod';
import { credentialTypeSchema } from '@openmap/contracts';
import { parseCidr } from '@openmap/scheduler';
import { Roles } from '../auth/roles.decorator.js';
import { ROLES } from '../auth/roles.js';
import type { CiRecord } from '../ci/ci.types.js';
import { parseInput } from '../common/validation.js';
import { TenantContext } from '../tenant/tenant.context.js';
import { DiscoveryService } from './discovery.service.js';
import type {
  DiscoveryJobView,
  DiscoveryNodeView,
  DiscoveryScopeView,
  SweepView,
} from './discovery.types.js';

const jobsArgs = z.object({
  status: z.enum(['scheduled', 'started', 'completed', 'failed']).nullish(),
  first: z.number().int().nullish(),
});
const runArgs = z.object({ collectorIds: z.array(z.string().min(1)).nullish(), siteId: z.uuid().nullish() });
const scopesArgs = z.object({ siteId: z.uuid().nullish() });

function isCidr(value: string): boolean {
  try {
    parseCidr(value);
    return true;
  } catch {
    return false;
  }
}

/** Exclusions must parse as IPv4 CIDRs; credential types come from the collector contract; limits are positive. */
const scopeInputSchema = z.object({
  exclusions: z
    .array(z.string().trim().refine(isCidr, 'exclusion must be an IPv4 CIDR (address/prefix)'))
    .nullish(),
  credentialRef: z.string().trim().min(1).nullish(),
  credentialType: credentialTypeSchema.nullish(),
  rateLimitConcurrency: z.number().int().positive().nullish(),
  rateLimitRps: z.number().positive().nullish(),
});
const updateScopeArgs = z.object({ ciId: z.uuid(), input: scopeInputSchema });

@Resolver()
export class DiscoveryResolver {
  constructor(
    private readonly service: DiscoveryService,
    private readonly tenant: TenantContext,
  ) {}

  @Query('discoveryNodes')
  discoveryNodes(): Promise<DiscoveryNodeView[]> {
    return this.service.nodes(this.tenant.tenantId);
  }

  @Query('discoveryJobs')
  discoveryJobs(@Args('status') status: unknown, @Args('first') first: unknown): Promise<DiscoveryJobView[]> {
    const a = parseInput(jobsArgs, { status, first }, 'discoveryJobs arguments');
    return this.service.jobs(this.tenant.tenantId, a.status ?? null, a.first);
  }

  @Query('currentSweep')
  currentSweep(): Promise<SweepView | null> {
    return this.service.currentSweep(this.tenant.tenantId);
  }

  @Query('discoveryScopes')
  discoveryScopes(@Args('siteId') siteId: unknown): Promise<DiscoveryScopeView[]> {
    const a = parseInput(scopesArgs, { siteId }, 'discoveryScopes arguments');
    return this.service.scopes(this.tenant.tenantId, a.siteId ?? null);
  }

  @Mutation('updateDiscoveryScope')
  @Roles(ROLES.operator)
  updateDiscoveryScope(
    @Args('ciId') ciId: unknown,
    @Args('input') input: unknown,
  ): Promise<DiscoveryScopeView> {
    const a = parseInput(updateScopeArgs, { ciId, input }, 'updateDiscoveryScope arguments');
    return this.service.updateScope(
      { tenantId: this.tenant.tenantId, username: this.tenant.username, requestId: this.tenant.requestId },
      a.ciId,
      a.input,
    );
  }

  @Mutation('runDiscovery')
  @Roles(ROLES.operator)
  runDiscovery(
    @Args('collectorIds') collectorIds: unknown,
    @Args('siteId') siteId: unknown,
  ): Promise<SweepView> {
    const a = parseInput(runArgs, { collectorIds, siteId }, 'runDiscovery arguments');
    return this.service.runDiscovery(
      this.tenant.tenantId,
      this.tenant.username,
      a.collectorIds ?? null,
      a.siteId ?? null,
    );
  }
}

@Resolver('DiscoveryNode')
export class DiscoveryNodeFieldsResolver {
  constructor(private readonly tenant: TenantContext) {}

  @ResolveField('site')
  site(@Parent() node: DiscoveryNodeView): Promise<CiRecord | null> {
    return node.siteCiId === null ? Promise.resolve(null) : this.tenant.loaders.ci.load(node.siteCiId);
  }
}

@Resolver('DiscoveryJob')
export class DiscoveryJobFieldsResolver {
  constructor(
    private readonly service: DiscoveryService,
    private readonly tenant: TenantContext,
  ) {}

  @ResolveField('node')
  node(@Parent() job: DiscoveryJobView): Promise<DiscoveryNodeView | null> {
    return this.service.node(this.tenant.tenantId, job.nodeId);
  }
}

@Resolver('DiscoveryScope')
export class DiscoveryScopeFieldsResolver {
  constructor(private readonly tenant: TenantContext) {}

  @ResolveField('ci')
  ci(@Parent() scope: DiscoveryScopeView): Promise<CiRecord | null> {
    return this.tenant.loaders.ci.load(scope.ciId);
  }

  @ResolveField('site')
  site(@Parent() scope: DiscoveryScopeView): Promise<CiRecord | null> {
    return scope.siteCiId === null ? Promise.resolve(null) : this.tenant.loaders.ci.load(scope.siteCiId);
  }
}
