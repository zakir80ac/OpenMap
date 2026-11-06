// REQ-CMDB-014 (ADR-037) — Query.components, Ci.components and HardwareComponent.ci.
import { Args, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { COMPONENTS } from '@openmap/constants';
import { COMPONENT_KINDS } from '@openmap/contracts';
import { z } from 'zod';
import type { CiRecord } from '../ci/ci.types.js';
import { parseInput } from '../common/validation.js';
import { TenantContext } from '../tenant/tenant.context.js';
import { ComponentsService, type ComponentPageView, type ComponentView } from './components.service.js';

const componentFilterSchema = z.object({
  kind: z.enum(COMPONENT_KINDS).nullish(),
  text: z.string().nullish(),
  includeRemoved: z.boolean().nullish(),
});
const pageSchema = z.object({
  first: z.number().int().min(0).max(COMPONENTS.maxPageSize).nullish(),
  offset: z.number().int().min(0).nullish(),
});

@Resolver()
export class ComponentsResolver {
  constructor(
    private readonly service: ComponentsService,
    private readonly tenant: TenantContext,
  ) {}

  @Query('components')
  components(@Args('filter') filter: unknown, @Args('first') first: unknown, @Args('offset') offset: unknown): Promise<ComponentPageView> {
    const f = parseInput(componentFilterSchema, filter ?? {}, 'ComponentFilter');
    const p = parseInput(pageSchema, { first, offset }, 'components');
    return this.service.page(
      this.tenant.tenantId,
      { kind: f.kind ?? null, text: f.text ?? null, includeRemoved: f.includeRemoved ?? false },
      p.first ?? COMPONENTS.pageSize,
      p.offset ?? 0,
    );
  }
}

@Resolver('Ci')
export class CiComponentsFieldResolver {
  constructor(
    private readonly service: ComponentsService,
    private readonly tenant: TenantContext,
  ) {}

  @ResolveField('components')
  components(@Parent() ci: CiRecord, @Args('includeRemoved') includeRemoved: unknown): Promise<ComponentView[]> {
    return this.service.ofCi(this.tenant.tenantId, ci.id, includeRemoved === true);
  }
}

@Resolver('HardwareComponent')
export class HardwareComponentFieldsResolver {
  constructor(private readonly tenant: TenantContext) {}

  @ResolveField('ci')
  async ci(@Parent() component: ComponentView): Promise<CiRecord> {
    const ci = await this.tenant.loaders.ci.load(component.ciId);
    if (ci === null) throw new Error('part ' + component.id + ' belongs to a CI that no longer exists');
    return ci;
  }
}
