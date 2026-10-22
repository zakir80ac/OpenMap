// REQ-DISC-029 — Query.discoveryNodes / discoveryJobs / currentSweep, Mutation.runDiscovery and the
// DiscoveryNode / DiscoveryJob field resolvers.
import { Args, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { z } from 'zod';
import { Roles } from '../auth/roles.decorator.js';
import { ROLES } from '../auth/roles.js';
import type { CiRecord } from '../ci/ci.types.js';
import { parseInput } from '../common/validation.js';
import { TenantContext } from '../tenant/tenant.context.js';
import { DiscoveryService } from './discovery.service.js';
import type { DiscoveryJobView, DiscoveryNodeView, SweepView } from './discovery.types.js';

const jobsArgs = z.object({ status: z.enum(['scheduled', 'started', 'completed', 'failed']).nullish(), first: z.number().int().nullish() });
const runArgs = z.object({ collectorIds: z.array(z.string().min(1)).nullish(), siteId: z.uuid().nullish() });

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

  @Mutation('runDiscovery')
  @Roles(ROLES.operator)
  runDiscovery(@Args('collectorIds') collectorIds: unknown, @Args('siteId') siteId: unknown): Promise<SweepView> {
    const a = parseInput(runArgs, { collectorIds, siteId }, 'runDiscovery arguments');
    return this.service.runDiscovery(this.tenant.tenantId, this.tenant.username, a.collectorIds ?? null, a.siteId ?? null);
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
