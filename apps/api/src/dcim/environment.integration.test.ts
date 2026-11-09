// T-539 REQ-DCIM-006 (ADR-060) — a room's environment against the compose stack, in a tenant of its own:
// - rack 1's own sensors read 29 °C at the inlet and 51 °C at the outlet: a warning inlet (outside the recommended
//   range) and starved airflow (a 22 °C rise);
// - rack 2's inlet probe sits on its PDU and reads 34 °C: critical (outside the allowable range);
// - rack 3's last reading is older than ENVIRONMENT.freshMs: shown, not judged;
// - the room's humidity (65 %) is a warning; the cooling unit's supply, return, humidity and capacity are read.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { ENVIRONMENT, TIME } from '@openmap/constants';
import { loadEnv } from '@openmap/config';
import { ENV_METRICS } from '@openmap/contracts';
import { createPrismaClient } from '@openmap/db';
import { AppModule } from '../app.module.js';
import { ClickHouseService, clickhouseTime } from '../db/clickhouse.service.js';
import { EnvironmentService } from './environment.service.js';

process.env['IMPACT_VALIDATION_INTERVAL_MS'] = '0';
process.env['ANOMALY_INTERVAL_MS'] = '0';
const env = loadEnv();
const prisma = createPrismaClient(env);
const TIMEOUT_MS = 120_000;
const WINDOW_HOURS = 24;
const organizationId = randomUUID();
const tenantId = randomUUID();
let app: NestFastifyApplication;

async function ci(type: 'room' | 'rack' | 'pdu' | 'cooling_unit', name: string): Promise<string> {
  const id = randomUUID();
  const now = new Date();
  const identity = { serialNumber: 'ENV-' + id.slice(0, 8) };
  await prisma.ci.create({
    data: {
      id, tenantId, type, identity, identityKey: identity.serialNumber, name, displayName: name, code: 'ENV-' + id.slice(0, 6).toUpperCase(),
      layer: 'dc', lifecycle: 'discovered', attributes: {}, tags: [], sourceCollectorId: 'itest', sourceNodeId: 'itest', sourceRunId: randomUUID(), sourceConfidence: 1, observedAt: now, validFrom: now, checksum: 'c'.repeat(64),
    },
  });
  return id;
}

async function locatedIn(from: string, to: string): Promise<void> {
  const now = new Date();
  await prisma.relationship.create({ data: { id: randomUUID(), tenantId, type: 'located_in', fromCiId: from, toCiId: to, attributes: {}, sourceCollectorId: 'itest', sourceNodeId: 'itest', sourceRunId: randomUUID(), sourceConfidence: 1, observedAt: now, validFrom: now } });
}

describe('room environment (integration)', () => {
  const ids: Record<string, string> = {};
  const id = (k: string): string => ids[k] ?? '';
  const now = Date.now();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), { logger: ['error', 'warn'] });
    await app.init();
    await prisma.organization.create({ data: { id: organizationId, name: 'Environment org', industry: 'test', timeZone: 'UTC', defaultLocale: 'en', regulatoryScope: [], airGapped: true } });
    await prisma.tenant.create({ data: { id: tenantId, organizationId, name: 'Environment BU', slug: 'environment-' + tenantId.slice(0, 8) } });
    ids['room'] = await ci('room', 'ENV-DH01');
    ids['rack1'] = await ci('rack', 'ENV-R01');
    ids['rack2'] = await ci('rack', 'ENV-R02');
    ids['rack3'] = await ci('rack', 'ENV-R03');
    ids['pdu2'] = await ci('pdu', 'ENV-R02 PDU-A');
    ids['crac'] = await ci('cooling_unit', 'ENV-CRAC-1');
    for (const r of ['rack1', 'rack2', 'rack3', 'crac']) await locatedIn(id(r), id('room'));
    await locatedIn(id('pdu2'), id('rack2'));
    const row = (ciId: string, metric: string, position: string, hoursAgo: number, value: number) => ({
      tenant_id: tenantId, ci_id: ciId, metric, ts: clickhouseTime(new Date(now - hoursAgo * TIME.msPerHour)), value, unit: 'C', labels: position === '' ? {} : { position }, source_run_id: randomUUID(),
    });
    const stale = ENVIRONMENT.freshMs / TIME.msPerHour + 1;
    await app.get(ClickHouseService).insert('metrics', [
      row(id('rack1'), ENV_METRICS.temperature, 'inlet', 2, 24),
      row(id('rack1'), ENV_METRICS.temperature, 'inlet', 1, 29),
      row(id('rack1'), ENV_METRICS.temperature, 'outlet', 1, 51),
      row(id('pdu2'), ENV_METRICS.temperature, 'inlet', 1, 34),
      row(id('rack3'), ENV_METRICS.temperature, 'inlet', stale, 40),
      row(id('room'), ENV_METRICS.humidity, 'room', 1, 65),
      row(id('crac'), ENV_METRICS.temperature, 'supply', 1, 16),
      row(id('crac'), ENV_METRICS.temperature, 'return', 1, 28),
      row(id('crac'), ENV_METRICS.humidity, 'return', 1, 45),
      row(id('crac'), ENV_METRICS.coolingCapacity, '', 1, 70),
    ]);
  }, TIMEOUT_MS);

  afterAll(async () => {
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    if (app !== undefined) await app.close();
    await prisma.$disconnect();
  }, TIMEOUT_MS);

  it('judges rack inlets, airflow and humidity, and reads the cooling unit', async () => {
    const view = await app.get(EnvironmentService).room(tenantId, id('room'), WINDOW_HOURS, new Date(now));
    const rack = (k: string) => view.racks.find((r) => r.rackId === id(k));
    expect(rack('rack1')).toMatchObject({ inletC: 29, outletC: 51, riseC: 22, temperatureState: 'warning', airflowState: 'warning', state: 'warning' });
    expect(rack('rack1')?.inletSeries.length).toBeGreaterThan(0);
    expect(rack('rack2')).toMatchObject({ inletC: 34, temperatureState: 'critical', airflowState: 'unknown', state: 'critical' });
    expect(rack('rack3')).toMatchObject({ inletC: 40, state: 'unknown' });
    expect(view).toMatchObject({ humidityRh: 65, humidityState: 'warning' });
    expect(view.coolingUnits).toEqual([{ unitId: id('crac'), supplyC: 16, returnC: 28, humidityRh: 45, capacityPercent: 70, state: 'normal' }]);
    expect(view.summary).toEqual({ racks: 3, normal: 0, warning: 1, critical: 1, unknown: 1, hottestInletC: 40 });
  }, TIMEOUT_MS);
});
