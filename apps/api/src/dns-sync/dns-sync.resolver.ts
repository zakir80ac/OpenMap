// REQ-IPAM-003 (ADR-055) — Query.dnsZoneSyncs / dnsChanges, Mutation.upsertDnsZoneSync / requestDnsChange.
import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { DNS_SYNC } from '@openmap/constants';
import { DNS_CHANGE_OPS, DNS_RECORD_TYPES } from '@openmap/contracts';
import { z } from 'zod';
import { Roles } from '../auth/roles.decorator.js';
import { ROLES } from '../auth/roles.js';
import type { Actor } from '../ci/ci.service.js';
import { parseInput } from '../common/validation.js';
import { TenantContext } from '../tenant/tenant.context.js';
import { DnsSyncService, type DnsChangeView, type DnsZoneSyncView } from './dns-sync.service.js';

const zoneSyncSchema = z.object({
  zone: z.string().trim().min(1),
  server: z.string().trim().min(1),
  port: z.number().int().positive().nullish(),
  tsigKeyName: z.string().trim().min(1).nullish(),
  tsigAlgorithm: z.string().trim().min(1).nullish(),
  credentialRef: z.string().trim().min(1).nullish(),
  siteId: z.uuid(),
  enabled: z.boolean().nullish(),
});
const changeSchema = z.object({
  zone: z.string(),
  op: z.enum(DNS_CHANGE_OPS),
  name: z.string(),
  recordType: z.enum(DNS_RECORD_TYPES),
  value: z.string(),
  ttl: z.number().int().nullish(),
});
const listSchema = z.object({ zone: z.string().trim().min(1).nullish(), limit: z.number().int().positive().nullish() });

@Resolver()
export class DnsSyncResolver {
  constructor(
    private readonly service: DnsSyncService,
    private readonly tenant: TenantContext,
  ) {}

  @Query('dnsZoneSyncs')
  dnsZoneSyncs(): Promise<DnsZoneSyncView[]> {
    return this.service.zones(this.tenant.tenantId);
  }

  @Query('dnsChanges')
  dnsChanges(@Args('zone') zone: unknown, @Args('limit') limit: unknown): Promise<DnsChangeView[]> {
    const a = parseInput(listSchema, { zone, limit }, 'dnsChanges');
    return this.service.changes(this.tenant.tenantId, a.zone ?? null, a.limit ?? DNS_SYNC.changesListLimit);
  }

  @Mutation('upsertDnsZoneSync')
  @Roles(ROLES.admin)
  upsertDnsZoneSync(@Args('input') input: unknown): Promise<DnsZoneSyncView> {
    const i = parseInput(zoneSyncSchema, input, 'DnsZoneSyncInput');
    return this.service.upsertZone(this.actor(), { zone: i.zone, server: i.server, port: i.port ?? null, tsigKeyName: i.tsigKeyName ?? null, tsigAlgorithm: i.tsigAlgorithm ?? null, credentialRef: i.credentialRef ?? null, siteId: i.siteId, enabled: i.enabled ?? true });
  }

  @Mutation('requestDnsChange')
  @Roles(ROLES.operator)
  requestDnsChange(@Args('input') input: unknown): Promise<DnsChangeView> {
    const i = parseInput(changeSchema, input, 'DnsChangeInput');
    return this.service.requestChange(this.actor(), { ...i, ttl: i.ttl ?? DNS_SYNC.defaultTtl });
  }

  private actor(): Actor {
    return { tenantId: this.tenant.tenantId, username: this.tenant.username, requestId: this.tenant.requestId };
  }
}
