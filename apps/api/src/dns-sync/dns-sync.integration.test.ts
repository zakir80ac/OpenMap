// T-517 REQ-IPAM-003 (ADR-055) — DNS sync settings and change requests against the compose stack:
// - a zone is kept in sync on one of the tenant's sites (another organisation's site is refused);
// - a change to a zone not kept in sync is refused, an invalid value is refused, a valid one is pending with its name
//   made absolute in the zone, audited through the outbox, and counted on the zone.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { loadEnv } from '@openmap/config';
import { createPrismaClient } from '@openmap/db';
import { AppModule } from '../app.module.js';
import { DnsSyncService } from './dns-sync.service.js';

process.env['IMPACT_VALIDATION_INTERVAL_MS'] = '0';
process.env['ANOMALY_INTERVAL_MS'] = '0';
const env = loadEnv();
const prisma = createPrismaClient(env);
const TIMEOUT_MS = 120_000;
const organizationId = randomUUID();
const otherOrganizationId = randomUUID();
const tenantId = randomUUID();
const siteId = randomUUID();
const otherSiteId = randomUUID();
const ZONE = 'itest-' + tenantId.slice(0, 6) + '.example';
const actor = { tenantId, username: 'dns-itest', requestId: randomUUID() };
let app: NestFastifyApplication;

describe('dns sync settings and change requests (integration)', () => {
  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), { logger: ['error', 'warn'] });
    await app.init();
    for (const id of [organizationId, otherOrganizationId]) await prisma.organization.create({ data: { id, name: 'DNS org ' + id.slice(0, 4), industry: 'test', timeZone: 'UTC', defaultLocale: 'en', regulatoryScope: [], airGapped: true } });
    await prisma.tenant.create({ data: { id: tenantId, organizationId, name: 'DNS BU', slug: 'dnsapi-' + tenantId.slice(0, 8) } });
    await prisma.site.create({ data: { id: siteId, organizationId, code: 'DNSA', name: 'DNS site', kind: 'datacenter', city: 'Riyadh', countryCode: 'SA', address: '', locationCount: 1 } });
    await prisma.site.create({ data: { id: otherSiteId, organizationId: otherOrganizationId, code: 'DNSB', name: 'Other site', kind: 'datacenter', city: 'Jeddah', countryCode: 'SA', address: '', locationCount: 1 } });
  }, TIMEOUT_MS);

  afterAll(async () => {
    await prisma.outboxEvent.deleteMany({ where: { tenantId } });
    await prisma.organization.deleteMany({ where: { id: { in: [organizationId, otherOrganizationId] } } });
    if (app !== undefined) await app.close();
    await prisma.$disconnect();
  }, TIMEOUT_MS);

  it('keeps a zone in sync and queues valid changes for it', async () => {
    const service = app.get(DnsSyncService);
    const base = { zone: ZONE + '.', server: '10.9.0.53', port: null, tsigKeyName: 'openmap-sync', tsigAlgorithm: null, credentialRef: 'cred/dns', enabled: true };
    await expect(service.upsertZone(actor, { ...base, siteId: otherSiteId })).rejects.toThrow(/not one of the tenant/);
    await expect(service.requestChange(actor, { zone: ZONE, op: 'add', name: 'api', recordType: 'A', value: '10.9.0.81', ttl: 600 })).rejects.toThrow(/not kept in sync/);

    const zone = await service.upsertZone(actor, { ...base, siteId });
    expect(zone).toMatchObject({ zone: ZONE, port: 53, enabled: true, pending: 0 });
    await expect(service.requestChange(actor, { zone: ZONE, op: 'add', name: 'api', recordType: 'A', value: 'not-an-address', ttl: 600 })).rejects.toThrow(/IPv4/);

    const change = await service.requestChange(actor, { zone: ZONE, op: 'add', name: 'api', recordType: 'A', value: '10.9.0.81', ttl: 600 });
    expect(change).toMatchObject({ zone: ZONE, name: 'api.' + ZONE, state: 'pending', requestedBy: 'dns-itest' });
    expect((await service.zones(tenantId))[0]?.pending).toBe(1);
    expect((await service.changes(tenantId, ZONE, 10)).map((c) => c.id)).toEqual([change.id]);
    const audits = await prisma.outboxEvent.findMany({ where: { tenantId, type: 'openmap.audit.action' }, select: { envelope: true } });
    const actions = audits.map((a) => ((a.envelope as { data: { action: string } }).data.action)).sort();
    expect(actions).toEqual(['dns.change.requested', 'dns.zone_sync.saved']);
  }, TIMEOUT_MS);
});
