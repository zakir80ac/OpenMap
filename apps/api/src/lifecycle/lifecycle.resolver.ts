// REQ-CMDB-023 REQ-CMDB-025 (ADR-039) — Query.lifecycleReleases, lifecycleHardware, lifecycleCatalogue,
// Mutation.syncLifecycleCatalogue and LifecycleRelease.instances.
import { Args, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { LIFECYCLE } from '@openmap/constants';
import { LIFECYCLE_KINDS, LIFECYCLE_STATES } from '@openmap/contracts';
import { z } from 'zod';
import { Roles } from '../auth/roles.decorator.js';
import { ROLES } from '../auth/roles.js';
import type { CiRecord } from '../ci/ci.types.js';
import { parseInput } from '../common/validation.js';
import { TenantContext } from '../tenant/tenant.context.js';
import { LifecycleService, type CatalogueView, type HardwareRowView, type ReleasePageView, type ReleaseRowView } from './lifecycle.service.js';

const releaseFilterSchema = z.object({
  kind: z.enum(LIFECYCLE_KINDS).nullish(),
  state: z.enum(LIFECYCLE_STATES).nullish(),
  text: z.string().nullish(),
});
const hardwareFilterSchema = z.object({ state: z.enum(LIFECYCLE_STATES).nullish(), text: z.string().nullish() });
const firstSchema = z.number().int().min(0).max(LIFECYCLE.instancesPerRelease).nullish();

@Resolver()
export class LifecycleResolver {
  constructor(
    private readonly service: LifecycleService,
    private readonly tenant: TenantContext,
  ) {}

  @Query('lifecycleReleases')
  releases(@Args('filter') filter: unknown): Promise<ReleasePageView> {
    const f = parseInput(releaseFilterSchema, filter ?? {}, 'LifecycleReleaseFilter');
    return this.service.releases(this.tenant.tenantId, { kind: f.kind ?? null, state: f.state ?? null, text: f.text ?? null });
  }

  @Query('lifecycleHardware')
  hardware(@Args('filter') filter: unknown): Promise<HardwareRowView[]> {
    const f = parseInput(hardwareFilterSchema, filter ?? {}, 'LifecycleHardwareFilter');
    return this.service.hardware(this.tenant.tenantId, f.state ?? null, f.text ?? null);
  }

  @Query('lifecycleCatalogue')
  catalogue(): Promise<CatalogueView> {
    return this.service.catalogue(this.tenant.tenantId);
  }

  @Mutation('syncLifecycleCatalogue')
  @Roles(ROLES.admin)
  sync(): Promise<{ catalogue: CatalogueView; failed: string[] }> {
    return this.service.sync(this.tenant.tenantId, { username: this.tenant.username, requestId: this.tenant.requestId });
  }
}

@Resolver('LifecycleRelease')
export class LifecycleReleaseFieldsResolver {
  constructor(private readonly tenant: TenantContext) {}

  @ResolveField('instances')
  async instances(@Parent() row: ReleaseRowView, @Args('first') first: unknown): Promise<CiRecord[]> {
    const n = parseInput(firstSchema, first, 'first') ?? LIFECYCLE.instancesPerRelease;
    const cis = await Promise.all(row.ciIds.slice(0, n).map((id) => this.tenant.loaders.ci.load(id)));
    return cis.filter((c): c is CiRecord => c !== null);
  }
}
