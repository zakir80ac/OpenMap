// T-547 REQ-DCIM-007 (ADR-061) — room capacity against the compose stack, in a tenant of its own:
// - a 42U rack with an 8 kW design holds a 2U server at U1 and a 48-port switch at U5 whose three discovered
//   interfaces are up, up and down; its PDU (16 A × 230 V) has eight days of rising daily draw ending at 3.4 kW; a
//   10 kW cooling unit sits in the room;
// - space: 39 U free in blocks of 2 and 37; power: 3,400 of 8,000 W, normal; ports: 2 of 48 live (the device's port
//   count wins over its three interfaces); cooling: 3.4 of 10 kW; the trend is rising with days to both lines.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { CAPACITY, TIME } from '@openmap/constants';
import { loadEnv } from '@openmap/config';
import { POWER_METRICS } from '@openmap/contracts';
import { createPrismaClient } from '@openmap/db';
import { AppModule } from '../app.module.js';
import { ClickHouseService, clickhouseTime } from '../db/clickhouse.service.js';
import { CapacityService } from './capacity.service.js';

process.env['IMPACT_VALIDATION_INTERVAL_MS'] = '0';
process.env['ANOMALY_INTERVAL_MS'] = '0';
const env = loadEnv();
const prisma = createPrismaClient(env);
const TIMEOUT_MS = 120_000;
const organizationId = randomUUID();
const tenantId = randomUUID();
let app: NestFastifyApplication;

type SeedType = 'room' | 'rack' | 'pdu' | 'host' | 'network_device' | 'interface' | 'cooling_unit';

async function ci(type: SeedType, name: string, attributes: Record<string, unknown>): Promise<string> {
  const id = randomUUID();
  const now = new Date();
  const identity = { serialNumber: 'CAP-' + id.slice(0, 8) };
  const layer =
    type === 'host'
      ? 'hardware'
      : type === 'network_device' || type === 'interface'
        ? 'network_security'
        : 'dc';
  await prisma.ci.create({
    data: {
      id,
      tenantId,
      type,
      identity,
      identityKey: identity.serialNumber,
      name,
      displayName: name,
      code: 'CAP-' + id.slice(0, 6).toUpperCase(),
      layer,
      lifecycle: 'discovered',
      attributes: attributes as object,
      tags: [],
      sourceCollectorId: 'itest',
      sourceNodeId: 'itest',
      sourceRunId: randomUUID(),
      sourceConfidence: 1,
      observedAt: now,
      validFrom: now,
      checksum: 'c'.repeat(64),
    },
  });
  return id;
}

async function rel(
  type: 'located_in' | 'mounted_on' | 'contains',
  from: string,
  to: string,
  attributes: Record<string, unknown> = {},
): Promise<void> {
  const now = new Date();
  await prisma.relationship.create({
    data: {
      id: randomUUID(),
      tenantId,
      type,
      fromCiId: from,
      toCiId: to,
      attributes: attributes as object,
      sourceCollectorId: 'itest',
      sourceNodeId: 'itest',
      sourceRunId: randomUUID(),
      sourceConfidence: 1,
      observedAt: now,
      validFrom: now,
    },
  });
}

describe('room capacity (integration)', () => {
  const ids: Record<string, string> = {};
  const id = (k: string): string => ids[k] ?? '';
  const now = Date.now();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
      logger: ['error', 'warn'],
    });
    await app.init();
    await prisma.organization.create({
      data: {
        id: organizationId,
        name: 'Capacity org',
        industry: 'test',
        timeZone: 'UTC',
        defaultLocale: 'en',
        regulatoryScope: [],
        airGapped: true,
      },
    });
    await prisma.tenant.create({
      data: { id: tenantId, organizationId, name: 'Capacity BU', slug: 'capacity-' + tenantId.slice(0, 8) },
    });
    ids['room'] = await ci('room', 'CAP-DH01', {});
    ids['rack'] = await ci('rack', 'CAP-R01', { heightU: 42, designKw: 8 });
    ids['pdu'] = await ci('pdu', 'CAP-R01 PDU-A', { feed: 'A', ratedAmps: 16, inputVoltage: 230 });
    ids['server'] = await ci('host', 'cap-srv-01', { heightU: 2, uPosition: 1 });
    ids['switch'] = await ci('network_device', 'cap-tor-01', { heightU: 1, uPosition: 5, portCount: 48 });
    ids['if1'] = await ci('interface', 'cap-tor-01 Gi1/0/1', { ifOperStatus: 'up' });
    ids['if2'] = await ci('interface', 'cap-tor-01 Gi1/0/2', { ifOperStatus: 'up' });
    ids['if3'] = await ci('interface', 'cap-tor-01 Gi1/0/3', { ifOperStatus: 'down' });
    ids['crac'] = await ci('cooling_unit', 'CAP-CRAC-1', { coolingKw: 10 });
    await rel('located_in', id('rack'), id('room'));
    await rel('located_in', id('pdu'), id('rack'));
    await rel('located_in', id('server'), id('rack'), { uPosition: 1, heightU: 2 });
    await rel('located_in', id('switch'), id('rack'), { uPosition: 5, heightU: 1 });
    await rel('contains', id('switch'), id('if1'));
    await rel('contains', id('switch'), id('if2'));
    await rel('contains', id('switch'), id('if3'));
    await rel('located_in', id('crac'), id('room'));
    // Eight days of draw, 100 W higher each day, the latest reading 3,400 W two hours ago.
    const rows = Array.from({ length: 8 }, (_, i) => ({
      tenant_id: tenantId,
      ci_id: id('pdu'),
      metric: POWER_METRICS.pdu,
      ts: clickhouseTime(new Date(now - (7 - i) * TIME.msPerDay - 2 * TIME.msPerHour)),
      value: 2_700 + i * 100,
      unit: 'W',
      labels: {},
      source_run_id: randomUUID(),
    }));
    await app.get(ClickHouseService).insert('metrics', rows);
  }, TIMEOUT_MS);

  afterAll(async () => {
    await prisma.outboxEvent.deleteMany({ where: { tenantId } });
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    if (app !== undefined) await app.close();
    await prisma.$disconnect();
  }, TIMEOUT_MS);

  it('reports space, power, cooling, ports and a rising trend for the room and its rack', async () => {
    const view = await app.get(CapacityService).room(tenantId, id('room'), new Date(now));
    expect(view.racks).toHaveLength(1);
    const rack = view.racks[0];
    expect(rack?.rackId).toBe(id('rack'));
    expect(rack?.space).toMatchObject({
      units: 42,
      occupied: 3,
      free: 39,
      largestFreeBlock: 37,
      freeBlocks: [2, 37],
    });
    expect(rack?.space.percent).toBeCloseTo((3 / 42) * 100);
    expect(rack?.power).toMatchObject({ designWatts: 8_000, loadWatts: 3_400, state: 'normal' });
    expect(rack?.power.percent).toBeCloseTo(42.5);
    expect(rack?.power.measuredAt).not.toBeNull();
    expect(rack?.ports).toEqual({
      total: 48,
      used: 2,
      free: 46,
      percent: expect.closeTo((2 / 48) * 100, 5) as number,
    });
    expect(rack?.state).toBe('normal');
    expect(view.space).toMatchObject({ units: 42, free: 39, largestFreeBlock: 37 });
    expect(view.power).toMatchObject({ designWatts: 8_000, loadWatts: 3_400, state: 'normal' });
    expect(view.cooling).toMatchObject({ capacityKw: 10, units: 1, state: 'normal' });
    expect(view.cooling.loadKw).toBeCloseTo(3.4);
    expect(view.cooling.percent).toBeCloseTo(34);
    expect(view.trend.days).toBe(CAPACITY.trendDays);
    expect(view.trend.points).toBe(8);
    expect(view.trend.slopeKwPerDay).toBeCloseTo(0.1, 2);
    // Warning at 5.6 kW from 3.4 kW rising 0.1 kW a day: 22 days; critical at 7.2 kW: 38 days.
    expect(view.trend.daysToWarning).toBe(22);
    expect(view.trend.daysToCritical).toBe(38);
    expect(view.state).toBe('normal');
  });

  it('refuses a room id that is not a room', async () => {
    await expect(app.get(CapacityService).room(tenantId, id('rack'))).rejects.toThrow(/not found/);
  });
});
