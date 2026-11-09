// REQ-DCIM-007 (ADR-061) — Query.roomCapacity and the field resolvers that load the room and rack CIs through the
// request's CI loader.
import { Args, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { z } from 'zod';
import type { CiRecord } from '../ci/ci.types.js';
import { parseInput } from '../common/validation.js';
import { TenantContext } from '../tenant/tenant.context.js';
import { CapacityService, type RackCapacityView, type RoomCapacityView } from './capacity.service.js';

const roomArg = z.uuid();

@Resolver()
export class CapacityResolver {
  constructor(
    private readonly service: CapacityService,
    private readonly tenant: TenantContext,
  ) {}

  @Query('roomCapacity')
  roomCapacity(@Args('roomId') roomId: unknown): Promise<RoomCapacityView> {
    return this.service.room(this.tenant.tenantId, parseInput(roomArg, roomId, 'roomId'));
  }
}

@Resolver('RoomCapacity')
export class RoomCapacityResolver {
  constructor(private readonly tenant: TenantContext) {}

  @ResolveField('room')
  room(@Parent() view: RoomCapacityView): Promise<CiRecord | null> {
    return this.tenant.loaders.ci.load(view.roomId);
  }
}

@Resolver('RackCapacity')
export class RackCapacityResolver {
  constructor(private readonly tenant: TenantContext) {}

  @ResolveField('rack')
  rack(@Parent() view: RackCapacityView): Promise<CiRecord | null> {
    return this.tenant.loaders.ci.load(view.rackId);
  }
}
