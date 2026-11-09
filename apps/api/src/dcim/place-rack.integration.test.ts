// T-524 REQ-DCIM-003 (ADR-057) — moving a rack on the floor plan against the compose stack, in a tenant of its own:
// - a rack moves to a free slot of another row in its room: its row and position attributes change and its
//   located_in moves to that row, audited through the outbox;
// - a slot another rack holds is refused, a slot past the row's capacity is refused, and a row in another room is
//   refused (a rack's identity is its room);
// - moving it back restores the layout.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { loadEnv } from '@openmap/config';
import { createPrismaClient } from '@openmap/db';
import { AppModule } from '../app.module.js';
import { DcimService } from './dcim.service.js';

process.env['IMPACT_VALIDATION_INTERVAL_MS'] = '0';
process.env['ANOMALY_INTERVAL_MS'] = '0';
const env = loadEnv();
const prisma = createPrismaClient(env);
const TIMEOUT_MS = 120_000;
const CAPACITY = 4;
const organizationId = randomUUID();
const tenantId = randomUUID();
const ACTOR = 'floor-itest';
let app: NestFastifyApplication;

async function ci(type: 'room' | 'row' | 'rack', name: string, identity: Record<string, string>, attributes: Record<string, unknown>): Promise<string> {
  const id = randomUUID();
  const now = new Date();
  await prisma.ci.create({
    data: {
      id, tenantId, type, identity, identityKey: Object.values(identity).join('|'), name, displayName: name, code: 'FLR-' + id.slice(0, 6).toUpperCase(),
      layer: 'dc', lifecycle: 'discovered', attributes: attributes as object, tags: [], sourceCollectorId: 'itest', sourceNodeId: 'itest', sourceRunId: randomUUID(), sourceConfidence: 1, observedAt: now, validFrom: now, checksum: 'c'.repeat(64),
    },
  });
  return id;
}

async function locatedIn(from: string, to: string): Promise<void> {
  const now = new Date();
  await prisma.relationship.create({ data: { id: randomUUID(), tenantId, type: 'located_in', fromCiId: from, toCiId: to, attributes: {}, sourceCollectorId: 'itest', sourceNodeId: 'itest', sourceRunId: randomUUID(), sourceConfidence: 1, observedAt: now, validFrom: now } });
}

describe('rack placement on the floor plan (integration)', () => {
  const ids: Record<string, string> = {};
  const id = (k: string): string => ids[k] ?? '';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), { logger: ['error', 'warn'] });
    await app.init();
    await prisma.organization.create({ data: { id: organizationId, name: 'Floor org', industry: 'test', timeZone: 'UTC', defaultLocale: 'en', regulatoryScope: [], airGapped: true } });
    await prisma.tenant.create({ data: { id: tenantId, organizationId, name: 'Floor BU', slug: 'floor-' + tenantId.slice(0, 8) } });
    ids['room'] = await ci('room', 'FLR-DH01', { buildingRef: 'FLR-B1', name: 'DH01' }, {});
    ids['otherRoom'] = await ci('room', 'FLR-DH02', { buildingRef: 'FLR-B1', name: 'DH02' }, {});
    ids['rowA'] = await ci('row', 'FLR-DH01-A', { roomRef: 'FLR-DH01', name: 'A' }, { position: 1, aisle: 'cold', rackCapacity: CAPACITY });
    ids['rowB'] = await ci('row', 'FLR-DH01-B', { roomRef: 'FLR-DH01', name: 'B' }, { position: 2, aisle: 'hot', rackCapacity: CAPACITY });
    ids['rowX'] = await ci('row', 'FLR-DH02-A', { roomRef: 'FLR-DH02', name: 'A' }, { position: 1, aisle: 'cold', rackCapacity: CAPACITY });
    ids['rack1'] = await ci('rack', 'FLR-DH01-A-01', { roomRef: 'FLR-DH01', name: 'A-01' }, { heightU: 42, row: 'A', position: 1 });
    ids['rack2'] = await ci('rack', 'FLR-DH01-B-01', { roomRef: 'FLR-DH01', name: 'B-01' }, { heightU: 42, row: 'B', position: 1 });
    for (const [row, room] of [['rowA', 'room'], ['rowB', 'room'], ['rowX', 'otherRoom']] as const) await locatedIn(id(row), id(room));
    await locatedIn(id('rack1'), id('rowA'));
    await locatedIn(id('rack2'), id('rowB'));
  }, TIMEOUT_MS);

  afterAll(async () => {
    await prisma.outboxEvent.deleteMany({ where: { tenantId } });
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    if (app !== undefined) await app.close();
    await prisma.$disconnect();
  }, TIMEOUT_MS);

  it('moves a rack within its room and refuses taken, missing and foreign slots', async () => {
    const service = app.get(DcimService);
    const moved = await service.placeRack(tenantId, ACTOR, id('rack1'), id('rowB'), 3);
    expect(moved.row?.id).toBe(id('rowB'));
    expect(moved.room?.id).toBe(id('room'));
    expect(moved.ci.attributes).toMatchObject({ row: 'B', position: 3 });
    const placed = await prisma.relationship.findMany({ where: { tenantId, fromCiId: id('rack1'), type: 'located_in', validTo: null } });
    expect(placed.map((r) => r.toCiId)).toEqual([id('rowB')]);

    await expect(service.placeRack(tenantId, ACTOR, id('rack1'), id('rowB'), 1)).rejects.toThrow(/holds FLR-DH01-B-01/);
    await expect(service.placeRack(tenantId, ACTOR, id('rack1'), id('rowB'), CAPACITY + 1)).rejects.toThrow(/has 4 slots/);
    await expect(service.placeRack(tenantId, ACTOR, id('rack1'), id('rowX'), 1)).rejects.toThrow(/within its room/);

    const back = await service.placeRack(tenantId, ACTOR, id('rack1'), id('rowA'), 1);
    expect(back.row?.id).toBe(id('rowA'));
    expect(back.ci.attributes).toMatchObject({ row: 'A', position: 1 });
    const audits = await prisma.outboxEvent.findMany({ where: { tenantId, type: 'openmap.audit.action' }, select: { envelope: true } });
    expect(audits.map((a) => (a.envelope as { data: { action: string } }).data.action)).toEqual(['dcim.rack.placed', 'dcim.rack.placed']);
  }, TIMEOUT_MS);
});
