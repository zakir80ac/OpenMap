// REQ-IPAM-003 (ADR-055) — two-way DNS sync: the zones kept in sync (the authoritative server, its TSIG key name, the
// credential holding the secret and the site whose Node reaches it) and the record changes people request. A change
// is pending until the scheduler sends it with the zone's next job; the zone transfer that follows the update settles
// it (applied or failed). Every write goes through the outbox with an audit event.
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DNS_SYNC } from '@openmap/constants';
import { dnsChangeInputSchema, dnsNameIn, type DnsChangeInput } from '@openmap/contracts';
import { withSpan } from '@openmap/telemetry';
import type { Actor } from '../ci/ci.service.js';
import { PrismaService } from '../db/prisma.service.js';
import { TRACER_NAME } from '../metrics/graphql-metrics.hook.js';
import { MetricsService } from '../metrics/metrics.service.js';
import { OutboxService } from '../outbox/outbox.service.js';

export interface DnsZoneSyncInput {
  zone: string;
  server: string;
  port: number | null;
  tsigKeyName: string | null;
  tsigAlgorithm: string | null;
  credentialRef: string | null;
  siteId: string;
  enabled: boolean;
}

export interface DnsZoneSyncView {
  id: string;
  zone: string;
  server: string;
  port: number;
  tsigKeyName: string | null;
  tsigAlgorithm: string | null;
  credentialRef: string | null;
  siteId: string;
  enabled: boolean;
  lastPullAt: Date | null;
  lastPushAt: Date | null;
  lastError: string | null;
  pending: number;
}

export interface DnsChangeView {
  id: string;
  zone: string;
  op: string;
  name: string;
  recordType: string;
  value: string;
  ttl: number;
  state: string;
  error: string | null;
  requestedBy: string;
  requestedAt: Date;
  settledAt: Date | null;
}

function bareZone(zone: string): string {
  return zone.trim().toLowerCase().replace(/\.$/u, '');
}

@Injectable()
export class DnsSyncService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly metrics: MetricsService,
  ) {}

  async zones(tenantId: string): Promise<DnsZoneSyncView[]> {
    const db = this.prisma.client;
    const [rows, pending] = await Promise.all([
      db.dnsZoneSync.findMany({ where: { tenantId }, orderBy: { zone: 'asc' } }),
      db.dnsChange.groupBy({ by: ['zone'], where: { tenantId, state: { in: ['pending', 'sent'] } }, _count: { _all: true } }),
    ]);
    const open = new Map(pending.map((p) => [p.zone, p._count._all]));
    return rows.map((r) => ({ ...r, pending: open.get(r.zone) ?? 0 }));
  }

  async changes(tenantId: string, zone: string | null, limit: number): Promise<DnsChangeView[]> {
    return this.prisma.client.dnsChange.findMany({
      where: { tenantId, ...(zone === null ? {} : { zone: bareZone(zone) }) },
      orderBy: { requestedAt: 'desc' },
      take: Math.min(Math.max(limit, 1), DNS_SYNC.changesListLimit),
    });
  }

  async upsertZone(actor: Actor, input: DnsZoneSyncInput): Promise<DnsZoneSyncView> {
    const zone = bareZone(input.zone);
    const site = await this.prisma.client.site.findFirst({ where: { id: input.siteId, organization: { tenants: { some: { id: actor.tenantId } } } }, select: { id: true } });
    if (site === null) throw new BadRequestException('site ' + input.siteId + ' is not one of the tenant’s sites');
    return this.outbox.transaction(actor.tenantId, async ({ tx, emit }) => {
      const data = { server: input.server.trim(), port: input.port ?? DNS_SYNC.defaultPort, tsigKeyName: input.tsigKeyName, tsigAlgorithm: input.tsigAlgorithm, credentialRef: input.credentialRef, siteId: input.siteId, enabled: input.enabled };
      const row = await tx.dnsZoneSync.upsert({ where: { tenantId_zone: { tenantId: actor.tenantId, zone } }, create: { tenantId: actor.tenantId, zone, ...data }, update: data });
      await emit({ type: 'openmap.audit.action', subject: row.id, data: { action: 'dns.zone_sync.saved', zone, server: data.server, enabled: data.enabled, by: actor.username } });
      return { ...row, pending: 0 };
    });
  }

  async requestChange(actor: Actor, input: DnsChangeInput): Promise<DnsChangeView> {
    const parsed = dnsChangeInputSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues.map((i) => i.path.join('.') + ': ' + i.message).join('; '));
    const c = parsed.data;
    const zone = bareZone(c.zone);
    return withSpan(TRACER_NAME, 'dns.change.request', { 'openmap.tenant': actor.tenantId, 'dns.zone': zone }, async () => {
      const sync = await this.prisma.client.dnsZoneSync.findUnique({ where: { tenantId_zone: { tenantId: actor.tenantId, zone } } });
      if (sync === null) throw new NotFoundException('zone ' + zone + ' is not kept in sync; configure its server first');
      const change = await this.outbox.transaction(actor.tenantId, async ({ tx, emit }) => {
        const row = await tx.dnsChange.create({
          data: { tenantId: actor.tenantId, zone, op: c.op, name: dnsNameIn(c.name, zone), recordType: c.recordType, value: c.value, ttl: c.ttl, state: 'pending', requestedBy: actor.username },
        });
        await emit({ type: 'openmap.audit.action', subject: row.id, data: { action: 'dns.change.requested', zone, op: c.op, name: row.name, recordType: c.recordType, value: c.value, by: actor.username } });
        return row;
      });
      this.metrics.dnsChanges.inc({ op: c.op });
      return change;
    });
  }
}
