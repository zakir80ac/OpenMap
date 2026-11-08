// T-504 REQ-AI-003 (ADR-053) — the anomaly rules against the compose stack, in a tenant of their own:
// - an address a server and an unknown device both claim is an ip_conflict, naming both;
// - an unknown, unlabelled device in a data centre is unmanaged_device_in_datacenter; one at a branch is not, and a
//   labelled one is not;
// - a service with ANOMALY.flapChanges health changes in an afternoon (ClickHouse) is flapping_service;
// - findings refresh on the next sweep and clear when the rule stops holding (the device is labelled);
// - in a locale the model does not write (ASSISTANT_PROSE_LOCALES), the explanation is the catalogue's template with
//   the finding's facts.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { ANOMALY, TIME } from '@openmap/constants';
import { loadEnv } from '@openmap/config';
import { createPrismaClient } from '@openmap/db';
import { AppModule } from '../app.module.js';
import { ClickHouseService } from '../db/clickhouse.service.js';
import { AnomalyService } from './anomaly.service.js';

process.env['IMPACT_VALIDATION_INTERVAL_MS'] = '0';
process.env['ANOMALY_INTERVAL_MS'] = '0';
process.env['ASSISTANT_PROSE_LOCALES'] = 'en';
const env = loadEnv();
const prisma = createPrismaClient(env);
const TIMEOUT_MS = 120_000;
const ARABIC = /[؀-ۿ]/u;
const organizationId = randomUUID();
const tenantId = randomUUID();
let app: NestFastifyApplication;

async function ci(type: 'site' | 'host' | 'unknown' | 'ip_address' | 'business_service', name: string, attributes: Record<string, unknown>, identity: Record<string, string>): Promise<string> {
  const id = randomUUID();
  const now = new Date();
  const layer = { site: 'dc', host: 'hardware', unknown: 'unknown', ip_address: 'network_security', business_service: 'applications' } as const;
  await prisma.ci.create({
    data: {
      id, tenantId, type, identity, identityKey: Object.values(identity).join('|'), name, displayName: name, code: 'ANO-' + id.slice(0, 6).toUpperCase(),
      layer: layer[type], lifecycle: 'discovered', attributes: attributes as object, tags: [], sourceCollectorId: 'itest', sourceNodeId: 'itest', sourceRunId: randomUUID(), sourceConfidence: 1, observedAt: now, validFrom: now, checksum: 'c'.repeat(64),
    },
  });
  return id;
}

async function rel(type: 'located_in' | 'uses_ip', from: string, to: string): Promise<void> {
  const now = new Date();
  await prisma.relationship.create({ data: { id: randomUUID(), tenantId, type, fromCiId: from, toCiId: to, attributes: {}, sourceCollectorId: 'itest', sourceNodeId: 'itest', sourceRunId: randomUUID(), sourceConfidence: 1, observedAt: now, validFrom: now } });
}

describe('anomaly rules (integration)', () => {
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), { logger: ['error', 'warn'] });
    await app.init();
    await prisma.organization.create({ data: { id: organizationId, name: 'Anomaly org', industry: 'test', timeZone: 'UTC', defaultLocale: 'en', regulatoryScope: [], airGapped: true } });
    await prisma.tenant.create({ data: { id: tenantId, organizationId, name: 'Anomaly BU', slug: 'anomaly-' + tenantId.slice(0, 8) } });
    ids['dc'] = await ci('site', 'Riyadh DC', { kind: 'datacenter' }, { code: 'ITEST-DC' });
    ids['branch'] = await ci('site', 'Branch 7', { kind: 'branch' }, { code: 'ITEST-BR' });
    ids['server'] = await ci('host', 'srv-itest-01', {}, { serialNumber: 'SN-ITEST-' + tenantId.slice(0, 6) });
    ids['ip'] = await ci('ip_address', '10.99.7.10', {}, { address: '10.99.7.10', vrfRef: 'global' });
    ids['intruder'] = await ci('unknown', 'iot_sensor-it01', { vendorFromOui: 'Raspberry Pi Foundation' }, { address: '10.99.7.10', primaryMac: 'd8:3a:dd:00:00:01' });
    ids['camera'] = await ci('unknown', 'camera-it02', { vendorFromOui: 'Axis Communications' }, { address: '10.99.0.20', primaryMac: 'ac:cc:8e:00:00:02' });
    ids['printer'] = await ci('unknown', 'printer-it03', {}, { address: '10.99.8.30', primaryMac: '3c:d9:2b:00:00:03' });
    ids['service'] = await ci('business_service', 'Cards ITEST', {}, { name: 'Cards ITEST ' + tenantId.slice(0, 6) });
    await rel('uses_ip', ids['server'] ?? '', ids['ip'] ?? '');
    await rel('uses_ip', ids['intruder'] ?? '', ids['ip'] ?? '');
    await rel('located_in', ids['intruder'] ?? '', ids['branch'] ?? '');
    await rel('located_in', ids['camera'] ?? '', ids['dc'] ?? '');
    await rel('located_in', ids['printer'] ?? '', ids['branch'] ?? '');
    const start = Date.now() - TIME.msPerHour * 2;
    const step = (TIME.msPerHour * 1.5) / ANOMALY.flapChanges;
    const rows = Array.from({ length: ANOMALY.flapChanges }, (_, i) => ({
      tenant_id: tenantId, service_ci_id: ids['service'], health: i % 2 === 0 ? 'down' : 'healthy', score: i % 2 === 0 ? 0 : 100, cause_ci_id: null, sla_budget_remaining_minutes: null,
      ts: new Date(start + i * step).toISOString().replace('T', ' ').replace('Z', ''),
    }));
    await app.get(ClickHouseService).insert('service_health_history', rows);
  }, TIMEOUT_MS);

  afterAll(async () => {
    await app.get(ClickHouseService).query('anomaly_itest_cleanup', 'ALTER TABLE ' + env.CLICKHOUSE_DB + '.service_health_history DELETE WHERE tenant_id = {tenantId:UUID}', { tenantId });
    await prisma.relationship.deleteMany({ where: { tenantId } });
    await prisma.tenant.deleteMany({ where: { id: tenantId } });
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    if (app !== undefined) await app.close();
    await prisma.$disconnect();
  }, TIMEOUT_MS);

  it('flags each anomaly, refreshes on the next sweep and clears what stops holding', async () => {
    const service = app.get(AnomalyService);
    await service.detect(tenantId);
    const first = await service.report(tenantId);
    const open = first.findings.filter((f) => f.state === 'open').map((f) => f.rule + ':' + f.subjectCiId).sort();
    expect(open).toEqual(['flapping_service:' + ids['service'], 'ip_conflict:' + ids['ip'], 'unmanaged_device_in_datacenter:' + ids['camera']].sort());
    const conflict = first.findings.find((f) => f.rule === 'ip_conflict');
    expect(conflict?.facts).toContainEqual({ key: 'claimants', value: 'iot_sensor-it01 (unknown), srv-itest-01 (host)' });
    const flap = first.findings.find((f) => f.rule === 'flapping_service');
    expect(flap?.facts).toContainEqual({ key: 'changes', value: String(ANOMALY.flapChanges) });

    const explained = await service.explain(tenantId, conflict?.id ?? '', 'ar');
    expect(explained.explanationLocale).toBe('ar');
    expect(explained.explanation).toContain('10.99.7.10');
    expect(explained.explanation).toMatch(ARABIC);

    await service.detect(tenantId);
    const again = await service.report(tenantId);
    expect(again.findings.find((f) => f.rule === 'ip_conflict')?.id).toBe(conflict?.id);

    await prisma.ci.update({ where: { id: ids['camera'] ?? '' }, data: { userLabel: { title: 'Lobby camera', description: 'known', layer: 'dc', labelledBy: 'itest', labelledAt: new Date().toISOString() } } });
    await service.detect(tenantId);
    const after = await service.report(tenantId);
    expect(after.findings.find((f) => f.rule === 'unmanaged_device_in_datacenter')).toMatchObject({ state: 'cleared' });
    expect(after.open).toBe(2);
  }, TIMEOUT_MS);
});
