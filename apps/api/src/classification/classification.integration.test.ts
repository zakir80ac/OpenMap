// T-499 REQ-AI-002 (ADR-052) — classification of unknown CIs against the compose stack:
// - in a tenant of its own, a sweep suggests a class for each recognisable unknown CI and counts the rest;
// - accepting writes the CI's user label (its layer, and its type where one fits), dismissing keeps the row, and the
//   acceptance rate is accepted / decided; a second sweep leaves decided suggestions alone, while new evidence on a
//   dismissed CI opens a new suggestion;
// - over every unknown CI the synthetic estates hold, the suggested class matches the device the generator placed
//   (its deviceKind, which the classifier never reads) for at least CLASSIFICATION_ACCURACY of them.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { classifyCi } from '@openmap/assistant';
import { loadEnv } from '@openmap/config';
import { createPrismaClient } from '@openmap/db';
import { AppModule } from '../app.module.js';
import { ClassificationService } from './classification.service.js';

process.env['IMPACT_VALIDATION_INTERVAL_MS'] = '0';
const env = loadEnv();
const prisma = createPrismaClient(env);
const TIMEOUT_MS = 120_000;
/** Share of the estates' unknown devices whose suggested class must match the generator's device. */
const CLASSIFICATION_ACCURACY = 0.95;
/** The generator's device kinds that name a class differently. */
const KIND_CLASS: Record<string, string> = {
  camera: 'network_camera',
  badge_printer: 'printer',
  signage: 'digital_signage',
  bms: 'building_management',
  ups_card: 'ups_management',
  wifi_ap: 'wireless_access_point',
  iot_sensor: 'iot_gateway',
  cash_counter: 'cash_handling',
};

const organizationId = randomUUID();
const tenantId = randomUUID();
const actor = { tenantId, username: 'classifier-itest', requestId: randomUUID() };
let app: NestFastifyApplication;

async function unknown(name: string, attributes: Record<string, unknown>): Promise<string> {
  const id = randomUUID();
  const now = new Date();
  await prisma.ci.create({
    data: {
      id, tenantId, type: 'unknown', identity: { address: name }, identityKey: name, name, displayName: name, code: 'CLS-' + id.slice(0, 6).toUpperCase(),
      layer: 'unknown', lifecycle: 'discovered', attributes: attributes as object, tags: [], sourceCollectorId: 'port-scan', sourceNodeId: 'itest', sourceRunId: randomUUID(), sourceConfidence: 1, observedAt: now, validFrom: now, checksum: 'c'.repeat(64),
    },
  });
  return id;
}

describe('classification of unknown CIs (integration)', () => {
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), { logger: ['error', 'warn'] });
    await app.init();
    await prisma.organization.create({ data: { id: organizationId, name: 'Classification org', industry: 'test', timeZone: 'UTC', defaultLocale: 'en', regulatoryScope: [], airGapped: true } });
    await prisma.tenant.create({ data: { id: tenantId, organizationId, name: 'Classification BU', slug: 'classify-' + tenantId.slice(0, 8) } });
    ids['ups'] = await unknown('ups-card-01', { sysDescr: 'APC Web/SNMP Management Card (MB:v4.1.0 MN:AP9641)', openPorts: [80, 443, 161], vendorFromOui: 'Schneider Electric' });
    ids['camera'] = await unknown('camera-01', { sysDescr: 'AXIS P3245-LVE Network Camera 10.12.166', openPorts: [80, 443, 554], vendorFromOui: 'Axis Communications' });
    ids['printer'] = await unknown('printer-01', { sysDescr: 'Zebra ZT411 Printer, Link-OS 6.8.20Z', openPorts: [80, 161, 9100], vendorFromOui: 'Zebra Technologies' });
    ids['mystery'] = await unknown('mystery-01', { openPorts: [22], vendorFromOui: 'Cisco Systems' });
  }, TIMEOUT_MS);

  afterAll(async () => {
    await prisma.outboxEvent.deleteMany({ where: { tenantId } });
    await prisma.assetRecord.deleteMany({ where: { tenantId } });
    await prisma.tenant.deleteMany({ where: { id: tenantId } });
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    if (app !== undefined) await app.close();
    await prisma.$disconnect();
  }, TIMEOUT_MS);

  it('suggests, accepts into the CI label, dismisses and counts the acceptance rate', async () => {
    const service = app.get(ClassificationService);
    const first = await service.summary(tenantId);
    expect(first.open.map((s) => s.deviceClass).sort()).toEqual(['network_camera', 'printer', 'ups_management']);
    expect(first).toMatchObject({ unrecognised: 1, accepted: 0, dismissed: 0, acceptanceRate: null });

    const ups = first.open.find((s) => s.ciId === ids['ups']);
    await service.accept(actor, ups?.id ?? '');
    const labelled = await prisma.ci.findUniqueOrThrow({ where: { id: ids['ups'] ?? '' } });
    expect(labelled).toMatchObject({ type: 'ups', layer: 'dc' });
    expect(labelled.userLabel).toMatchObject({ layer: 'dc', type: 'ups', title: 'APC Web/SNMP Management Card (MB:v4.1.0 MN:AP9641)', labelledBy: 'classifier-itest' });

    const camera = first.open.find((s) => s.ciId === ids['camera']);
    await service.dismiss(actor, camera?.id ?? '');
    const second = await service.summary(tenantId);
    expect(second.open.map((s) => s.deviceClass)).toEqual(['printer']);
    expect(second).toMatchObject({ accepted: 1, dismissed: 1, acceptanceRate: 0.5 });
    await expect(service.accept(actor, camera?.id ?? '')).rejects.toThrow(/not found/);

    // New evidence on the dismissed camera (its RTSP port closed, a banner now answers) opens a new suggestion.
    await prisma.ci.update({ where: { id: ids['camera'] ?? '' }, data: { attributes: { sysDescr: 'AXIS P3245-LVE Network Camera 10.12.166', openPorts: [80, 443], vendorFromOui: 'Axis Communications', httpBanner: 'Axis camera web server' } } });
    const third = await service.summary(tenantId);
    expect(third.open.map((s) => s.deviceClass).sort()).toEqual(['network_camera', 'printer']);
  }, TIMEOUT_MS);

  it('matches the device the generator placed for the estates’ unknown CIs', async () => {
    const rows = await prisma.ci.findMany({ where: { type: 'unknown', validTo: null, sourceCollectorId: 'port-scan' }, select: { name: true, attributes: true } });
    const known = rows.filter((r) => typeof (r.attributes as Record<string, unknown>)['deviceKind'] === 'string');
    expect(known.length).toBeGreaterThan(0);
    let right = 0;
    const misses = new Map<string, number>();
    for (const r of known) {
      const attributes = { ...(r.attributes as Record<string, unknown>) };
      const kind = String(attributes['deviceKind']);
      delete attributes['deviceKind'];
      const c = classifyCi({ name: r.name, attributes });
      if (c?.deviceClass === (KIND_CLASS[kind] ?? kind)) right++;
      else misses.set(kind, (misses.get(kind) ?? 0) + 1);
    }
    console.log(JSON.stringify({ msg: 'classification accuracy', devices: known.length, right, accuracy: right / known.length, misses: Object.fromEntries(misses) }));
    expect(right / known.length).toBeGreaterThanOrEqual(CLASSIFICATION_ACCURACY);
  }, TIMEOUT_MS);
});
