// REQ-IPAM-005 (ADR-064) — Query.firewallDevices, Query.firewallPolicy, Query.firewallCheck and the field resolvers that
// load the device, rule and object CIs through the request's CI loader.
import { Args, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { FIREWALL } from '@openmap/constants';
import { parseIp } from '@openmap/contracts';
import { z } from 'zod';
import type { CiRecord } from '../ci/ci.types.js';
import { parseInput } from '../common/validation.js';
import { TenantContext } from '../tenant/tenant.context.js';
import {
  FirewallService,
  type FirewallCheckResultView,
  type FirewallCheckView,
  type FirewallDeviceView,
  type FirewallObjectOut,
  type FirewallPolicyView,
  type FirewallRuleOut,
} from './firewall.service.js';

const idArg = z.uuid();
const textArg = z.string().trim().max(FIREWALL.checkTextMaxLength).nullable().optional();
const address = z
  .string()
  .trim()
  .min(1)
  .max(FIREWALL.checkTextMaxLength)
  .refine((v) => parseIp(v) !== null, { message: 'an IPv4 or IPv6 address' });
const optionalWord = z.string().trim().min(1).max(FIREWALL.checkTextMaxLength).nullable().optional();
const checkInput = z.object({
  source: address,
  destination: address,
  protocol: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[\p{Ll}\p{Nd}]+$/u)
    .max(FIREWALL.protocolMaxLength),
  port: z.number().int().min(0).max(FIREWALL.maxPort).nullable().optional(),
  deviceId: z.uuid().nullable().optional(),
  fromZone: optionalWord,
  toZone: optionalWord,
  inInterface: optionalWord,
  outInterface: optionalWord,
});

@Resolver()
export class FirewallResolver {
  constructor(
    private readonly service: FirewallService,
    private readonly tenant: TenantContext,
  ) {}

  @Query('firewallDevices')
  firewallDevices(@Args('text') text: unknown): Promise<FirewallDeviceView[]> {
    return this.service.devices(this.tenant.tenantId, parseInput(textArg, text, 'text') ?? '');
  }

  @Query('firewallPolicy')
  firewallPolicy(@Args('deviceId') deviceId: unknown): Promise<FirewallPolicyView> {
    return this.service.policy(this.tenant.tenantId, parseInput(idArg, deviceId, 'deviceId'));
  }

  @Query('firewallCheck')
  firewallCheck(@Args('input') input: unknown): Promise<FirewallCheckView> {
    const i = parseInput(checkInput, input, 'input');
    return this.service.check(this.tenant.tenantId, {
      source: i.source,
      destination: i.destination,
      protocol: i.protocol,
      port: i.port ?? null,
      deviceId: i.deviceId ?? null,
      fromZone: i.fromZone ?? null,
      toZone: i.toZone ?? null,
      inInterface: i.inInterface ?? null,
      outInterface: i.outInterface ?? null,
    });
  }
}

@Resolver('FirewallDevice')
export class FirewallDeviceResolver {
  constructor(private readonly tenant: TenantContext) {}

  @ResolveField('device')
  device(@Parent() view: FirewallDeviceView): Promise<CiRecord | null> {
    return this.tenant.loaders.ci.load(view.deviceId);
  }
}

@Resolver('FirewallPolicy')
export class FirewallPolicyResolver {
  constructor(private readonly tenant: TenantContext) {}

  @ResolveField('device')
  device(@Parent() view: FirewallPolicyView): Promise<CiRecord | null> {
    return this.tenant.loaders.ci.load(view.deviceId);
  }
}

@Resolver('FirewallRule')
export class FirewallRuleResolver {
  constructor(private readonly tenant: TenantContext) {}

  @ResolveField('rule')
  rule(@Parent() view: FirewallRuleOut): Promise<CiRecord | null> {
    return this.tenant.loaders.ci.load(view.id);
  }
}

@Resolver('FirewallObject')
export class FirewallObjectResolver {
  constructor(private readonly tenant: TenantContext) {}

  @ResolveField('object')
  object(@Parent() view: FirewallObjectOut): Promise<CiRecord | null> {
    return this.tenant.loaders.ci.load(view.id);
  }
}

@Resolver('FirewallCheckResult')
export class FirewallCheckResultResolver {
  constructor(private readonly tenant: TenantContext) {}

  @ResolveField('device')
  device(@Parent() view: FirewallCheckResultView): Promise<CiRecord | null> {
    return this.tenant.loaders.ci.load(view.deviceId);
  }
}
