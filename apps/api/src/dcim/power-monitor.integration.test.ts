// T-533 REQ-DCIM-005 (ADR-059) — power monitoring and billing against the compose stack, in a tenant of its own:
// - a rack's PDU (16 A × 230 V) draws 3.0 then 3.4 kW over two hours; its two outlets draw 1 kW and 0.5 kW; a server's
//   cord to the PDU carries outlet 1, and a switch is powered by outlet 2's CI;
// - with the default lines the PDU's latest draw (92% of its rating) is critical, with the series, peak and energy
//   between its samples; the outlets' energy is billed to the server on outlet 1; without a tariff no price is shown;
// - an administrator sets the lines and a tariff: the PDU is then a warning, and every energy has its cost; the change
//   is audited.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { TIME } from '@openmap/constants';
import { loadEnv } from '@openmap/config';
import { POWER_METRICS } from '@openmap/contracts';
import { createPrismaClient } from '@openmap/db';
import { AppModule } from '../app.module.js';
import { ClickHouseService, clickhouseTime } from '../db/clickhouse.service.js';
import { PowerMonitorService } from './power-monitor.service.js';

process.env['IMPACT_VALIDATION_INTERVAL_MS'] = '0';
process.env['ANOMALY_INTERVAL_MS'] = '0';
const env = loadEnv();
const prisma = createPrismaClient(env);
const TIMEOUT_MS = 120_000;
const WINDOW_HOURS = 24;
const organizationId = randomUUID();
const tenantId = randomUUID();
const ACTOR = 'monitor-itest';
let app: NestFastifyApplication;

async function ci(type: 'room' | 'rack' | 'pdu' | 'power_feed' | 'host', name: string, attributes: Record<string, unknown>): Promise<string> {
  const id = randomUUID();
  const now = new Date();
  const identity = { serialNumber: 'MON-' + id.slice(0, 8) };
  await prisma.ci.create({
    data: {
      id, tenantId, type, identity, identityKey: identity.serialNumber, name, displayName: name, code: 'MON-' + id.slice(0, 6).toUpperCase(),
      layer: type === 'host' ? 'hardware' : 'dc', lifecycle: 'discovered', attributes: attributes as object, tags: [], sourceCollectorId: 'itest', sourceNodeId: 'itest', sourceRunId: randomUUID(), sourceConfidence: 1, observedAt: now, validFrom: now, checksum: 'c'.repeat(64),
    },
  });
  return id;
}

async function rel(type: 'located_in' | 'powered_by' | 'contains', from: string, to: string, attributes: Record<string, unknown> = {}): Promise<void> {
  const now = new Date();
  await prisma.relationship.create({ data: { id: randomUUID(), tenantId, type, fromCiId: from, toCiId: to, attributes: attributes as object, sourceCollectorId: 'itest', sourceNodeId: 'itest', sourceRunId: randomUUID(), sourceConfidence: 1, observedAt: now, validFrom: now } });
}

describe('power monitoring and billing (integration)', () => {
  const ids: Record<string, string> = {};
  const id = (k: string): string => ids[k] ?? '';
  const now = Date.now();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), { logger: ['error', 'warn'] });
    await app.init();
    await prisma.organization.create({ data: { id: organizationId, name: 'Monitor org', industry: 'test', timeZone: 'UTC', defaultLocale: 'en', regulatoryScope: [], airGapped: true } });
    await prisma.tenant.create({ data: { id: tenantId, organizationId, name: 'Monitor BU', slug: 'monitor-' + tenantId.slice(0, 8) } });
    ids['room'] = await ci('room', 'MON-DH01', {});
    ids['rack'] = await ci('rack', 'MON-R01', { heightU: 42 });
    ids['pdu'] = await ci('pdu', 'MON-R01 PDU-A', { feed: 'A', ratedAmps: 16, inputVoltage: 230, measuredKw: 3.4, outlets: 24 });
    ids['out1'] = await ci('power_feed', 'MON-R01 PDU-A outlet 1', { outletIndex: '1' });
    ids['out2'] = await ci('power_feed', 'MON-R01 PDU-A outlet 2', { outletIndex: '2' });
    ids['server'] = await ci('host', 'mon-srv-01', {});
    ids['switch'] = await ci('host', 'mon-tor-01', {});
    await rel('located_in', id('rack'), id('room'));
    await rel('located_in', id('pdu'), id('rack'));
    await rel('contains', id('pdu'), id('out1'));
    await rel('contains', id('pdu'), id('out2'));
    await rel('powered_by', id('server'), id('pdu'), { feed: 'A', psu: 1, outlet: 1 });
    // The other form: a device powered by the outlet CI itself.
    await rel('powered_by', id('switch'), id('out2'), { feed: 'A', psu: 1 });
    const row = (ciId: string, metric: string, hoursAgo: number, value: number) => ({ tenant_id: tenantId, ci_id: ciId, metric, ts: clickhouseTime(new Date(now - hoursAgo * TIME.msPerHour)), value, unit: 'W', labels: {}, source_run_id: randomUUID() });
    await app.get(ClickHouseService).insert('metrics', [
      row(id('pdu'), POWER_METRICS.pdu, 4, 3_000),
      row(id('pdu'), POWER_METRICS.pdu, 2, 3_400),
      row(id('out1'), POWER_METRICS.outlet, 4, 1_000),
      row(id('out1'), POWER_METRICS.outlet, 2, 1_000),
      row(id('out2'), POWER_METRICS.outlet, 4, 500),
      row(id('out2'), POWER_METRICS.outlet, 2, 500),
    ]);
  }, TIMEOUT_MS);

  afterAll(async () => {
    await prisma.outboxEvent.deleteMany({ where: { tenantId } });
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    if (app !== undefined) await app.close();
    await prisma.$disconnect();
  }, TIMEOUT_MS);

  it('monitors the PDU against the lines, bills outlet energy to the device and prices it with a tariff', async () => {
    const service = app.get(PowerMonitorService);
    const before = await service.monitor(tenantId, id('room'), WINDOW_HOURS, new Date(now));
    expect(before.settings).toMatchObject({ tariffPerKwh: null, currency: null });
    const pdu = before.pdus[0];
    expect(pdu).toMatchObject({ pduId: id('pdu'), rackId: id('rack'), feed: 'A', ratedWatts: 3_680, latestWatts: 3_400, peakWatts: 3_400, state: 'critical', coveredHours: 2, cost: null });
    expect(pdu?.energyKwh).toBeCloseTo(6.4);
    expect(pdu?.series.length).toBeGreaterThan(0);
    expect(before.outlets.map((o) => [o.outletIndex, o.deviceId, o.energyKwh])).toEqual([
      ['1', id('server'), 2],
      ['2', id('switch'), 1],
    ]);
    expect(before.devices).toEqual([
      { deviceId: id('server'), costCentreId: null, outlets: 1, energyKwh: 2, cost: null },
      { deviceId: id('switch'), costCentreId: null, outlets: 1, energyKwh: 1, cost: null },
    ]);
    expect(before.totalCost).toBeNull();

    const settings = await service.updateSettings(tenantId, ACTOR, { warnPercent: 50, criticalPercent: 95, tariffPerKwh: 0.25, currency: 'SAR' });
    expect(settings).toEqual({ warnPercent: 50, criticalPercent: 95, tariffPerKwh: 0.25, currency: 'SAR' });
    const after = await service.monitor(tenantId, id('room'), WINDOW_HOURS, new Date(now));
    expect(after.pdus[0]?.state).toBe('warning');
    expect(after.devices[0]?.cost).toBeCloseTo(0.5);
    expect(after.totalCost).toBeCloseTo(1.6);
    const audits = await prisma.outboxEvent.findMany({ where: { tenantId, type: 'openmap.audit.action' }, select: { envelope: true } });
    expect(audits.map((a) => (a.envelope as { data: { action: string } }).data.action)).toEqual(['dcim.power.settings.saved']);
  }, TIMEOUT_MS);
});
