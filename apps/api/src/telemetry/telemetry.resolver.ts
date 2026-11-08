// REQ-UI-027 — Query.telemetryFleet and FleetRow.ci.
import { Args, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { TELEMETRY } from '@openmap/constants';
import { CI_LAYERS, FLEET_SORTS } from '@openmap/contracts';
import { z } from 'zod';
import type { CiRecord } from '../ci/ci.types.js';
import { parseInput } from '../common/validation.js';
import { TenantContext } from '../tenant/tenant.context.js';
import { TelemetryService, type FleetPageView, type FleetRowView } from './telemetry.service.js';

const filterSchema = z.object({
  layers: z.array(z.enum(CI_LAYERS)).nullish(),
  health: z.array(z.enum(['healthy', 'degraded', 'down', 'unknown'])).nullish(),
  text: z.string().nullish(),
});
const pageSchema = z.object({
  sort: z.enum(FLEET_SORTS).nullish(),
  first: z.number().int().min(0).max(TELEMETRY.maxPageSize).nullish(),
  offset: z.number().int().min(0).nullish(),
});

@Resolver()
export class TelemetryResolver {
  constructor(
    private readonly service: TelemetryService,
    private readonly tenant: TenantContext,
  ) {}

  @Query('telemetryFleet')
  telemetryFleet(@Args('filter') filter: unknown, @Args('sort') sort: unknown, @Args('first') first: unknown, @Args('offset') offset: unknown): Promise<FleetPageView> {
    const f = parseInput(filterSchema, filter ?? {}, 'FleetFilter');
    const p = parseInput(pageSchema, { sort, first, offset }, 'telemetryFleet');
    return this.service.fleet(
      this.tenant.tenantId,
      { layers: f.layers ?? null, health: f.health ?? null, text: f.text ?? null },
      p.sort ?? 'health',
      p.first ?? TELEMETRY.defaultPageSize,
      p.offset ?? 0,
    );
  }
}

@Resolver('FleetRow')
export class FleetRowFieldsResolver {
  constructor(private readonly tenant: TenantContext) {}

  @ResolveField('ci')
  async ci(@Parent() row: FleetRowView): Promise<CiRecord> {
    const ci = await this.tenant.loaders.ci.load(row.ciId);
    if (ci === null) throw new Error('fleet row ' + row.ciId + ' names a CI that no longer exists');
    return ci;
  }
}
