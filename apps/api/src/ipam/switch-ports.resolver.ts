// REQ-IPAM-004 (ADR-063) — Query.switchPorts, Query.portHistory, Query.macLookup and the field resolvers that load the
// device, port, neighbour and MAC owner CIs through the request's CI loader.
import { Args, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { SWITCH_PORTS } from '@openmap/constants';
import { z } from 'zod';
import type { CiRecord } from '../ci/ci.types.js';
import { parseInput } from '../common/validation.js';
import { TenantContext } from '../tenant/tenant.context.js';
import {
  SwitchPortsService,
  type LearnedMacView,
  type MacLookupView,
  type MacSightingView,
  type PortHistoryView,
  type PortNeighbourView,
  type SwitchPortView,
  type SwitchPortsView,
} from './switch-ports.service.js';

const idArg = z.uuid();
const daysArg = z.number().int().positive().max(SWITCH_PORTS.historyDays).nullable().optional();
const macArg = z.string().trim().min(1).max(SWITCH_PORTS.macTextMaxLength);

@Resolver()
export class SwitchPortsResolver {
  constructor(
    private readonly service: SwitchPortsService,
    private readonly tenant: TenantContext,
  ) {}

  @Query('switchPorts')
  switchPorts(@Args('deviceId') deviceId: unknown): Promise<SwitchPortsView> {
    return this.service.switchPorts(this.tenant.tenantId, parseInput(idArg, deviceId, 'deviceId'));
  }

  @Query('portHistory')
  portHistory(@Args('portId') portId: unknown, @Args('days') days: unknown): Promise<PortHistoryView> {
    return this.service.portHistory(
      this.tenant.tenantId,
      parseInput(idArg, portId, 'portId'),
      parseInput(daysArg, days, 'days') ?? SWITCH_PORTS.historyDays,
    );
  }

  @Query('macLookup')
  macLookup(@Args('mac') mac: unknown): Promise<MacLookupView> {
    return this.service.macLookup(this.tenant.tenantId, parseInput(macArg, mac, 'mac'));
  }
}

@Resolver('SwitchPorts')
export class SwitchPortsFieldsResolver {
  constructor(private readonly tenant: TenantContext) {}

  @ResolveField('device')
  device(@Parent() view: SwitchPortsView): Promise<CiRecord | null> {
    return this.tenant.loaders.ci.load(view.deviceId);
  }
}

@Resolver('SwitchPort')
export class SwitchPortResolver {
  constructor(private readonly tenant: TenantContext) {}

  @ResolveField('port')
  port(@Parent() view: SwitchPortView): Promise<CiRecord | null> {
    return this.tenant.loaders.ci.load(view.portId);
  }
}

@Resolver('PortHistory')
export class PortHistoryResolver {
  constructor(private readonly tenant: TenantContext) {}

  @ResolveField('port')
  port(@Parent() view: PortHistoryView): Promise<CiRecord | null> {
    return this.tenant.loaders.ci.load(view.portId);
  }
}

@Resolver('PortNeighbour')
export class PortNeighbourResolver {
  constructor(private readonly tenant: TenantContext) {}

  @ResolveField('ci')
  ci(@Parent() view: PortNeighbourView): Promise<CiRecord | null> {
    return this.tenant.loaders.ci.load(view.ciId);
  }
}

@Resolver('LearnedMac')
export class LearnedMacResolver {
  constructor(private readonly tenant: TenantContext) {}

  @ResolveField('owner')
  owner(@Parent() view: LearnedMacView): Promise<CiRecord | null> {
    return view.ownerId === null ? Promise.resolve(null) : this.tenant.loaders.ci.load(view.ownerId);
  }
}

@Resolver('MacSighting')
export class MacSightingResolver {
  constructor(private readonly tenant: TenantContext) {}

  @ResolveField('ci')
  ci(@Parent() view: MacSightingView): Promise<CiRecord | null> {
    return this.tenant.loaders.ci.load(view.ciId);
  }
}
