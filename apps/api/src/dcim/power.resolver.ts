// REQ-DCIM-004 (ADR-058) — Query.powerChain / pduConnections, Mutation.connectPower / disconnectPower (operators),
// and the field resolvers that load the CIs a source, finding or cord names through the request's CI loader.
import { Args, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { powerConnectionInputSchema, type PowerFinding } from '@openmap/contracts';
import { z } from 'zod';
import { Roles } from '../auth/roles.decorator.js';
import { ROLES } from '../auth/roles.js';
import type { CiRecord } from '../ci/ci.types.js';
import { parseInput } from '../common/validation.js';
import { TenantContext } from '../tenant/tenant.context.js';
import { PowerService, type PowerChainView, type PowerConnectionView, type PowerSourceView } from './power.service.js';

const idArg = z.uuid();

@Resolver()
export class PowerResolver {
  constructor(
    private readonly service: PowerService,
    private readonly tenant: TenantContext,
  ) {}

  @Query('powerChain')
  powerChain(@Args('roomId') roomId: unknown): Promise<PowerChainView> {
    return this.service.chain(this.tenant.tenantId, parseInput(idArg, roomId, 'room id'));
  }

  @Query('pduConnections')
  pduConnections(@Args('pduId') pduId: unknown): Promise<PowerConnectionView[]> {
    return this.service.connections(this.tenant.tenantId, parseInput(idArg, pduId, 'pdu id'));
  }

  @Mutation('connectPower')
  @Roles(ROLES.operator)
  connectPower(@Args('input') input: unknown): Promise<PowerConnectionView> {
    const record = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
    const value = { outlet: null, psu: null, ...record };
    return this.service.connect(this.tenant.tenantId, this.tenant.username, parseInput(powerConnectionInputSchema, value, 'PowerConnectionInput'));
  }

  @Mutation('disconnectPower')
  @Roles(ROLES.operator)
  disconnectPower(@Args('id') id: unknown): Promise<boolean> {
    return this.service.disconnect(this.tenant.tenantId, this.tenant.username, parseInput(idArg, id, 'power connection id'));
  }
}

@Resolver('PowerSource')
export class PowerSourceResolver {
  constructor(private readonly tenant: TenantContext) {}

  @ResolveField('fedBy')
  async fedBy(@Parent() source: PowerSourceView): Promise<CiRecord[]> {
    const found = await this.tenant.loaders.ci.loadMany(source.fedByIds);
    return found.filter((c): c is CiRecord => c !== null && !(c instanceof Error));
  }

  @ResolveField('rack')
  rack(@Parent() source: PowerSourceView): Promise<CiRecord | null> {
    return source.rackId === null ? Promise.resolve(null) : this.tenant.loaders.ci.load(source.rackId);
  }
}

@Resolver('PowerFinding')
export class PowerFindingResolver {
  constructor(private readonly tenant: TenantContext) {}

  @ResolveField('ci')
  ci(@Parent() finding: PowerFinding): Promise<CiRecord | null> {
    return this.tenant.loaders.ci.load(finding.ciId);
  }

  @ResolveField('partner')
  partner(@Parent() finding: PowerFinding): Promise<CiRecord | null> {
    return finding.partnerId === null ? Promise.resolve(null) : this.tenant.loaders.ci.load(finding.partnerId);
  }
}

@Resolver('PowerConnection')
export class PowerConnectionResolver {
  constructor(private readonly tenant: TenantContext) {}

  @ResolveField('device')
  device(@Parent() c: PowerConnectionView): Promise<CiRecord | null> {
    return this.tenant.loaders.ci.load(c.deviceId);
  }

  @ResolveField('pdu')
  pdu(@Parent() c: PowerConnectionView): Promise<CiRecord | null> {
    return this.tenant.loaders.ci.load(c.pduId);
  }
}
