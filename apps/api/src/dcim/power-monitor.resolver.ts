// REQ-DCIM-005 (ADR-059) — Query.powerSettings / powerMonitor, Mutation.updatePowerSettings (administrators), and the
// field resolvers that load the PDU, rack, outlet, device and cost-centre CIs through the request's CI loader.
import { Args, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { UTILISATION } from '@openmap/constants';
import { powerSettingsSchema, type PowerSettings } from '@openmap/contracts';
import { z } from 'zod';
import { Roles } from '../auth/roles.decorator.js';
import { ROLES } from '../auth/roles.js';
import type { CiRecord } from '../ci/ci.types.js';
import { parseInput } from '../common/validation.js';
import { TenantContext } from '../tenant/tenant.context.js';
import { PowerMonitorService, type DeviceBillView, type OutletBillView, type PduMonitorView, type PowerMonitorView } from './power-monitor.service.js';

const monitorArgs = z.object({ roomId: z.uuid(), hours: z.number().int().refine((h) => (UTILISATION.windowsHours as readonly number[]).includes(h), 'a window the screen offers') });

@Resolver()
export class PowerMonitorResolver {
  constructor(
    private readonly service: PowerMonitorService,
    private readonly tenant: TenantContext,
  ) {}

  @Query('powerSettings')
  powerSettings(): Promise<PowerSettings> {
    return this.service.settings(this.tenant.tenantId);
  }

  @Query('powerMonitor')
  powerMonitor(@Args('roomId') roomId: unknown, @Args('hours') hours: unknown): Promise<PowerMonitorView> {
    const a = parseInput(monitorArgs, { roomId, hours }, 'powerMonitor arguments');
    return this.service.monitor(this.tenant.tenantId, a.roomId, a.hours);
  }

  @Mutation('updatePowerSettings')
  @Roles(ROLES.admin)
  updatePowerSettings(@Args('input') input: unknown): Promise<PowerSettings> {
    const record = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
    const value = { tariffPerKwh: null, currency: null, ...record };
    return this.service.updateSettings(this.tenant.tenantId, this.tenant.username, parseInput(powerSettingsSchema, value, 'PowerSettingsInput'));
  }
}

@Resolver('PduMonitor')
export class PduMonitorResolver {
  constructor(private readonly tenant: TenantContext) {}

  @ResolveField('pdu')
  pdu(@Parent() p: PduMonitorView): Promise<CiRecord | null> {
    return this.tenant.loaders.ci.load(p.pduId);
  }

  @ResolveField('rack')
  rack(@Parent() p: PduMonitorView): Promise<CiRecord | null> {
    return p.rackId === null ? Promise.resolve(null) : this.tenant.loaders.ci.load(p.rackId);
  }
}

@Resolver('OutletBill')
export class OutletBillResolver {
  constructor(private readonly tenant: TenantContext) {}

  @ResolveField('outlet')
  outlet(@Parent() o: OutletBillView): Promise<CiRecord | null> {
    return this.tenant.loaders.ci.load(o.outletId);
  }

  @ResolveField('pdu')
  pdu(@Parent() o: OutletBillView): Promise<CiRecord | null> {
    return this.tenant.loaders.ci.load(o.pduId);
  }

  @ResolveField('device')
  device(@Parent() o: OutletBillView): Promise<CiRecord | null> {
    return o.deviceId === null ? Promise.resolve(null) : this.tenant.loaders.ci.load(o.deviceId);
  }
}

@Resolver('DeviceBill')
export class DeviceBillResolver {
  constructor(private readonly tenant: TenantContext) {}

  @ResolveField('device')
  device(@Parent() d: DeviceBillView): Promise<CiRecord | null> {
    return this.tenant.loaders.ci.load(d.deviceId);
  }

  @ResolveField('costCentre')
  costCentre(@Parent() d: DeviceBillView): Promise<CiRecord | null> {
    return d.costCentreId === null ? Promise.resolve(null) : this.tenant.loaders.ci.load(d.costCentreId);
  }
}
