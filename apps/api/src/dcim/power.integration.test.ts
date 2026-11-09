// T-529 REQ-DCIM-004 (ADR-058) — a room's power chain against the compose stack, in a tenant of its own:
// - two UPS units feed two circuits, which feed a rack's A and B PDUs; one server is cabled to both PDUs, one to A only;
// - the chain lists the UPS units, circuits and PDUs with their ratings, loads, outlets and what feeds them;
// - the findings: the single-corded server, PDU A unable to carry both PDUs' loads if B fails, and the UPS whose
//   battery runtime is short;
// - a cord recorded on a free outlet takes the PDU's feed; a taken outlet and one past the PDU's count are refused;
//   removing the cord retires its relationship; both writes are audited.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { POWER } from '@openmap/constants';
import { loadEnv } from '@openmap/config';
import { createPrismaClient } from '@openmap/db';
import { AppModule } from '../app.module.js';
import { PowerService } from './power.service.js';

process.env['IMPACT_VALIDATION_INTERVAL_MS'] = '0';
process.env['ANOMALY_INTERVAL_MS'] = '0';
const env = loadEnv();
const prisma = createPrismaClient(env);
const TIMEOUT_MS = 120_000;
const OUTLETS = 2;
const organizationId = randomUUID();
const tenantId = randomUUID();
const ACTOR = 'power-itest';
let app: NestFastifyApplication;

type SeedType = 'room' | 'rack' | 'ups' | 'power_circuit' | 'pdu' | 'host';
async function ci(type: SeedType, name: string, attributes: Record<string, unknown>): Promise<string> {
  const id = randomUUID();
  const now = new Date();
  const identity = { serialNumber: 'PWR-' + id.slice(0, 8) };
  await prisma.ci.create({
    data: {
      id, tenantId, type, identity, identityKey: identity.serialNumber, name, displayName: name, code: 'PWR-' + id.slice(0, 6).toUpperCase(),
      layer: type === 'host' ? 'hardware' : 'dc', lifecycle: 'discovered', attributes: attributes as object, tags: [], sourceCollectorId: 'itest', sourceNodeId: 'itest', sourceRunId: randomUUID(), sourceConfidence: 1, observedAt: now, validFrom: now, checksum: 'c'.repeat(64),
    },
  });
  return id;
}

async function rel(type: 'located_in' | 'powered_by', from: string, to: string, attributes: Record<string, unknown> = {}): Promise<void> {
  const now = new Date();
  await prisma.relationship.create({ data: { id: randomUUID(), tenantId, type, fromCiId: from, toCiId: to, attributes: attributes as object, sourceCollectorId: 'itest', sourceNodeId: 'itest', sourceRunId: randomUUID(), sourceConfidence: 1, observedAt: now, validFrom: now } });
}

describe('power chain and outlets (integration)', () => {
  const ids: Record<string, string> = {};
  const id = (k: string): string => ids[k] ?? '';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), { logger: ['error', 'warn'] });
    await app.init();
    await prisma.organization.create({ data: { id: organizationId, name: 'Power org', industry: 'test', timeZone: 'UTC', defaultLocale: 'en', regulatoryScope: [], airGapped: true } });
    await prisma.tenant.create({ data: { id: tenantId, organizationId, name: 'Power BU', slug: 'power-' + tenantId.slice(0, 8) } });
    ids['room'] = await ci('room', 'PWR-DH01', {});
    ids['rack'] = await ci('rack', 'PWR-R01', { heightU: 42 });
    ids['upsA'] = await ci('ups', 'PWR UPS-A', { feed: 'A', ratedKw: 100, loadPercent: 40, batteryRuntimeMinutes: POWER.minUpsRuntimeMinutes - 1 });
    ids['upsB'] = await ci('ups', 'PWR UPS-B', { feed: 'B', ratedKw: 100, loadPercent: 30, batteryRuntimeMinutes: POWER.minUpsRuntimeMinutes * 2 });
    ids['cktA'] = await ci('power_circuit', 'PWR-DH01-A', { feed: 'A', ratedAmps: 63, voltage: 400, phases: 3 });
    ids['cktB'] = await ci('power_circuit', 'PWR-DH01-B', { feed: 'B', ratedAmps: 63, voltage: 400, phases: 3 });
    // A is rated 16 A × 230 V = 3.68 kW and draws 2.5 kW; B is rated 32 A and draws 2 kW: A cannot carry 4.5 kW alone.
    ids['pduA'] = await ci('pdu', 'PWR-R01 PDU-A', { feed: 'A', ratedAmps: 16, inputVoltage: 230, measuredKw: 2.5, outlets: OUTLETS });
    ids['pduB'] = await ci('pdu', 'PWR-R01 PDU-B', { feed: 'B', ratedAmps: 32, inputVoltage: 230, measuredKw: 2, outlets: OUTLETS });
    ids['dual'] = await ci('host', 'pwr-srv-dual', {});
    ids['single'] = await ci('host', 'pwr-srv-single', {});
    ids['spare'] = await ci('host', 'pwr-srv-spare', {});
    await rel('located_in', id('rack'), id('room'));
    for (const k of ['upsA', 'upsB']) await rel('located_in', id(k), id('room'));
    await rel('powered_by', id('cktA'), id('upsA'));
    await rel('powered_by', id('cktB'), id('upsB'));
    for (const [pdu, ckt] of [['pduA', 'cktA'], ['pduB', 'cktB']] as const) {
      await rel('located_in', id(pdu), id('rack'));
      await rel('powered_by', id(pdu), id(ckt));
    }
    await rel('powered_by', id('dual'), id('pduA'), { feed: 'A', psu: 1, outlet: 1 });
    await rel('powered_by', id('dual'), id('pduB'), { feed: 'B', psu: 2, outlet: 1 });
    await rel('powered_by', id('single'), id('pduA'), { feed: 'A', psu: 1 });
  }, TIMEOUT_MS);

  afterAll(async () => {
    await prisma.outboxEvent.deleteMany({ where: { tenantId } });
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    if (app !== undefined) await app.close();
    await prisma.$disconnect();
  }, TIMEOUT_MS);

  it('assesses the chain and records cords on outlets', async () => {
    const service = app.get(PowerService);
    const chain = await service.chain(tenantId, id('room'));
    expect(chain.summary).toMatchObject({ ups: 2, circuits: 2, pdus: 2, devices: 2, redundantDevices: 1 });
    const pduA = chain.sources.find((s) => s.ci.id === id('pduA'));
    expect(pduA).toMatchObject({ kind: 'pdu', feed: 'A', ratedWatts: 3_680, loadWatts: 2_500, outlets: OUTLETS, outletsUsed: 2, fedByIds: [id('cktA')], rackId: id('rack') });
    expect(chain.sources.find((s) => s.ci.id === id('cktA'))).toMatchObject({ kind: 'power_circuit', loadWatts: 2_500, fedByIds: [id('upsA')] });
    expect(chain.sources.find((s) => s.ci.id === id('upsB'))).toMatchObject({ kind: 'ups', ratedWatts: 100_000, loadWatts: 30_000 });
    const kinds = chain.findings.map((f) => [f.kind, f.ciId]);
    expect(kinds).toContainEqual(['single_corded', id('single')]);
    expect(kinds).toContainEqual(['pdu_failover_overload', id('pduA')]);
    expect(kinds).toContainEqual(['ups_low_runtime', id('upsA')]);
    expect(kinds).not.toContainEqual(['pdu_failover_overload', id('pduB')]);

    const cord = await service.connect(tenantId, ACTOR, { deviceId: id('spare'), pduId: id('pduB'), outlet: 2, psu: 1 });
    expect(cord).toMatchObject({ deviceId: id('spare'), pduId: id('pduB'), feed: 'B', outlet: 2, psu: 1 });
    await expect(service.connect(tenantId, ACTOR, { deviceId: id('single'), pduId: id('pduB'), outlet: 2, psu: 2 })).rejects.toThrow(/outlet 2 feeds pwr-srv-spare/);
    await expect(service.connect(tenantId, ACTOR, { deviceId: id('single'), pduId: id('pduB'), outlet: OUTLETS + 1, psu: 2 })).rejects.toThrow(/has 2 outlets/);
    await expect(service.connect(tenantId, ACTOR, { deviceId: id('cktA'), pduId: id('pduB'), outlet: null, psu: null })).rejects.toThrow(/part of the power chain/);
    expect((await service.connections(tenantId, id('pduB'))).map((c) => c.outlet)).toEqual([1, 2]);

    expect(await service.disconnect(tenantId, ACTOR, cord.id)).toBe(true);
    expect((await service.connections(tenantId, id('pduB'))).map((c) => c.deviceId)).toEqual([id('dual')]);
    const audits = await prisma.outboxEvent.findMany({ where: { tenantId, type: 'openmap.audit.action' }, select: { envelope: true } });
    expect(audits.map((a) => (a.envelope as { data: { action: string } }).data.action).sort()).toEqual(['dcim.power.connected', 'dcim.power.disconnected']);
  }, TIMEOUT_MS);
});
