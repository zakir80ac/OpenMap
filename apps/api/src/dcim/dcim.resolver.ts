// REQ-DCIM-001 REQ-DCIM-003 — Query.racks and Mutation.placeRack (operators).
import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { z } from 'zod';
import { Roles } from '../auth/roles.decorator.js';
import { ROLES } from '../auth/roles.js';
import { parseInput } from '../common/validation.js';
import { TenantContext } from '../tenant/tenant.context.js';
import { DcimService, type RackView } from './dcim.service.js';

const racksArgs = z.object({ roomId: z.uuid().nullish() });
const placeArgs = z.object({ rackId: z.uuid(), rowId: z.uuid(), position: z.number().int().positive() });

@Resolver()
export class DcimResolver {
  constructor(
    private readonly service: DcimService,
    private readonly tenant: TenantContext,
  ) {}

  @Query('racks')
  racks(@Args('roomId') roomId: unknown): Promise<RackView[]> {
    const a = parseInput(racksArgs, { roomId }, 'racks arguments');
    return this.service.racks(this.tenant.tenantId, a.roomId ?? null);
  }

  @Mutation('placeRack')
  @Roles(ROLES.operator)
  placeRack(@Args('rackId') rackId: unknown, @Args('rowId') rowId: unknown, @Args('position') position: unknown): Promise<RackView> {
    const a = parseInput(placeArgs, { rackId, rowId, position }, 'placeRack arguments');
    return this.service.placeRack(this.tenant.tenantId, this.tenant.username, a.rackId, a.rowId, a.position);
  }
}
