// REQ-IPAM-001 — Query.subnets / nextFreeIp and the Subnet field resolvers (addresses, children).
import { Args, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { z } from 'zod';
import { pagingSchema } from '../ci/ci.schemas.js';
import type { CiRecord, Connection } from '../ci/ci.types.js';
import { parseInput } from '../common/validation.js';
import { TenantContext } from '../tenant/tenant.context.js';
import { IpamService, type SubnetView } from './ipam.service.js';

const subnetsArgs = z.object({ parentId: z.uuid().nullish() });
const idArg = z.uuid();

@Resolver()
export class IpamResolver {
  constructor(
    private readonly service: IpamService,
    private readonly tenant: TenantContext,
  ) {}

  @Query('subnets')
  subnets(@Args('parentId') parentId: unknown): Promise<SubnetView[]> {
    const a = parseInput(subnetsArgs, { parentId }, 'subnets arguments');
    return this.service.subnets(this.tenant.tenantId, a.parentId ?? null);
  }

  @Query('nextFreeIp')
  nextFreeIp(@Args('subnetId') subnetId: unknown): Promise<string | null> {
    return this.service.nextFreeIp(this.tenant.tenantId, parseInput(idArg, subnetId, 'subnet id'));
  }
}

@Resolver('Subnet')
export class SubnetFieldsResolver {
  constructor(
    private readonly service: IpamService,
    private readonly tenant: TenantContext,
  ) {}

  @ResolveField('addresses')
  addresses(@Parent() subnet: SubnetView, @Args('first') first: unknown, @Args('after') after: unknown): Promise<Connection<CiRecord>> {
    const page = parseInput(pagingSchema, { first, after }, 'paging');
    return this.service.addresses(this.tenant.tenantId, subnet.ci.id, page.first, page.after);
  }

  @ResolveField('children')
  children(@Parent() subnet: SubnetView): Promise<SubnetView[]> {
    return this.service.subnets(this.tenant.tenantId, subnet.ci.id);
  }
}
