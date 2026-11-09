// REQ-DCIM-006 (ADR-060) — Query.roomEnvironment and the field resolvers that load the rack and cooling-unit CIs through
// the request's CI loader.
import { Args, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { UTILISATION } from '@openmap/constants';
import { z } from 'zod';
import type { CiRecord } from '../ci/ci.types.js';
import { parseInput } from '../common/validation.js';
import { TenantContext } from '../tenant/tenant.context.js';
import { EnvironmentService, type CoolingEnvironmentView, type RackEnvironmentView, type RoomEnvironmentView } from './environment.service.js';

const args = z.object({ roomId: z.uuid(), hours: z.number().int().refine((h) => (UTILISATION.windowsHours as readonly number[]).includes(h), 'a window the screen offers') });

@Resolver()
export class EnvironmentResolver {
  constructor(
    private readonly service: EnvironmentService,
    private readonly tenant: TenantContext,
  ) {}

  @Query('roomEnvironment')
  roomEnvironment(@Args('roomId') roomId: unknown, @Args('hours') hours: unknown): Promise<RoomEnvironmentView> {
    const a = parseInput(args, { roomId, hours }, 'roomEnvironment arguments');
    return this.service.room(this.tenant.tenantId, a.roomId, a.hours);
  }
}

@Resolver('RackEnvironment')
export class RackEnvironmentResolver {
  constructor(private readonly tenant: TenantContext) {}

  @ResolveField('rack')
  rack(@Parent() r: RackEnvironmentView): Promise<CiRecord | null> {
    return this.tenant.loaders.ci.load(r.rackId);
  }
}

@Resolver('CoolingEnvironment')
export class CoolingEnvironmentResolver {
  constructor(private readonly tenant: TenantContext) {}

  @ResolveField('unit')
  unit(@Parent() c: CoolingEnvironmentView): Promise<CiRecord | null> {
    return this.tenant.loaders.ci.load(c.unitId);
  }
}
