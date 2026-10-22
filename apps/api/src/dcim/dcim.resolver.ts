// REQ-DCIM-001 — Query.racks.
import { Args, Query, Resolver } from '@nestjs/graphql';
import { z } from 'zod';
import { parseInput } from '../common/validation.js';
import { TenantContext } from '../tenant/tenant.context.js';
import { DcimService, type RackView } from './dcim.service.js';

const racksArgs = z.object({ roomId: z.uuid().nullish() });

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
}
