// REQ-CMDB-034 — Query.utilisation, Ci.utilisation and UtilisationRow.ci.
import { Args, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { UTILISATION } from '@openmap/constants';
import { UTILISATION_MEASURES } from '@openmap/contracts';
import { z } from 'zod';
import type { CiRecord } from '../ci/ci.types.js';
import { parseInput } from '../common/validation.js';
import { TenantContext } from '../tenant/tenant.context.js';
import { UtilisationService, type CiUtilisationView, type UtilisationPageView, type UtilisationRowView } from './utilisation.service.js';

const STATES = ['hot', 'idle', 'normal', 'unknown'] as const;
const filterSchema = z.object({
  types: z.array(z.string().min(1)).nullish(),
  state: z.enum(STATES).nullish(),
  text: z.string().nullish(),
});
const pageSchema = z.object({
  sort: z.enum([...UTILISATION_MEASURES, 'name']).nullish(),
  first: z.number().int().min(0).max(UTILISATION.maxPageSize).nullish(),
  offset: z.number().int().min(0).nullish(),
});
const hoursSchema = z.number().int().positive().max(Math.max(...UTILISATION.windowsHours)).nullish();

@Resolver()
export class UtilisationResolver {
  constructor(
    private readonly service: UtilisationService,
    private readonly tenant: TenantContext,
  ) {}

  @Query('utilisation')
  utilisation(@Args('filter') filter: unknown, @Args('sort') sort: unknown, @Args('first') first: unknown, @Args('offset') offset: unknown): Promise<UtilisationPageView> {
    const f = parseInput(filterSchema, filter ?? {}, 'UtilisationFilter');
    const p = parseInput(pageSchema, { sort, first, offset }, 'utilisation');
    return this.service.register(
      this.tenant.tenantId,
      { types: f.types ?? null, state: f.state ?? null, text: f.text ?? null },
      p.sort ?? 'cpu',
      p.first ?? UTILISATION.pageSize,
      p.offset ?? 0,
    );
  }
}

@Resolver('Ci')
export class CiUtilisationFieldResolver {
  constructor(
    private readonly service: UtilisationService,
    private readonly tenant: TenantContext,
  ) {}

  @ResolveField('utilisation')
  utilisation(@Parent() ci: CiRecord, @Args('hours') hours: unknown): Promise<CiUtilisationView | null> {
    const h = parseInput(hoursSchema, hours, 'hours') ?? UTILISATION.defaultWindowHours;
    return this.service.ofCi(this.tenant.tenantId, ci.id, ci.type, h);
  }
}

@Resolver('UtilisationRow')
export class UtilisationRowFieldsResolver {
  constructor(private readonly tenant: TenantContext) {}

  @ResolveField('ci')
  async ci(@Parent() row: UtilisationRowView): Promise<CiRecord> {
    const ci = await this.tenant.loaders.ci.load(row.ciId);
    if (ci === null) throw new Error('utilisation row ' + row.ciId + ' names a CI that no longer exists');
    return ci;
  }
}
