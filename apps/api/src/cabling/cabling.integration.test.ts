// T-521 REQ-DCIM-001 (ADR-056) — structured cabling against the compose stack, in a tenant of its own:
// - a patch panel is mounted in a rack (located_in, with its rack unit) and listed with its positions;
// - cables join a switch port to panel 1's front, panel 1's rear to panel 2's rear (a trunk), and panel 2's front to a
//   server port; a port takes one cable (a second is refused), a panel position needs a side within the panel, and a
//   panel cannot shrink below a position in use;
// - the trace from the switch port walks both panels to the server port, and from the server back;
// - a carrier circuit terminates on panel 2's rear position 2 (Z end described as the provider's POP);
// - disconnecting a cable retires it with its ends, so the trace stops at the panel; a panel with a cable on it cannot be
//   removed, a bare one and a circuit can; every write is audited.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { loadEnv } from '@openmap/config';
import { createPrismaClient } from '@openmap/db';
import { AppModule } from '../app.module.js';
import { CablingService } from './cabling.service.js';

process.env['IMPACT_VALIDATION_INTERVAL_MS'] = '0';
process.env['ANOMALY_INTERVAL_MS'] = '0';
const env = loadEnv();
const prisma = createPrismaClient(env);
const TIMEOUT_MS = 120_000;
const organizationId = randomUUID();
const tenantId = randomUUID();
const ACTOR = 'cabling-itest';
let app: NestFastifyApplication;

type SeedType = 'rack' | 'network_device' | 'host';
async function ci(type: SeedType, name: string, identity: Record<string, string>, attributes: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID();
  const now = new Date();
  const layer = { rack: 'dc', network_device: 'network_security', host: 'hardware' } as const;
  await prisma.ci.create({
    data: {
      id, tenantId, type, identity, identityKey: Object.values(identity).join('|'), name, displayName: name, code: 'CAB-' + id.slice(0, 6).toUpperCase(),
      layer: layer[type], lifecycle: 'discovered', attributes: attributes as object, tags: [], sourceCollectorId: 'itest', sourceNodeId: 'itest', sourceRunId: randomUUID(), sourceConfidence: 1, observedAt: now, validFrom: now, checksum: 'c'.repeat(64),
    },
  });
  return id;
}

describe('structured cabling (integration)', () => {
  const ids: Record<string, string> = {};
  const id = (k: string): string => ids[k] ?? '';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), { logger: ['error', 'warn'] });
    await app.init();
    await prisma.organization.create({ data: { id: organizationId, name: 'Cabling org', industry: 'test', timeZone: 'UTC', defaultLocale: 'en', regulatoryScope: [], airGapped: true } });
    await prisma.tenant.create({ data: { id: tenantId, organizationId, name: 'Cabling BU', slug: 'cabling-' + tenantId.slice(0, 8) } });
    ids['rackA'] = await ci('rack', 'ITEST-R01', { roomRef: 'ITEST-DH01', name: 'R01' }, { heightU: 42 });
    ids['rackB'] = await ci('rack', 'ITEST-R02', { roomRef: 'ITEST-DH01', name: 'R02' }, { heightU: 42 });
    ids['switch'] = await ci('network_device', 'itest-tor-01', { serialNumber: 'SN-TOR-' + tenantId.slice(0, 6) });
    ids['server'] = await ci('host', 'itest-srv-01', { serialNumber: 'SN-SRV-' + tenantId.slice(0, 6) });
  }, TIMEOUT_MS);

  afterAll(async () => {
    await prisma.outboxEvent.deleteMany({ where: { tenantId } });
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    if (app !== undefined) await app.close();
    await prisma.$disconnect();
  }, TIMEOUT_MS);

  it('mounts panels, patches a path through them, traces it, terminates a circuit and disconnects', async () => {
    const service = app.get(CablingService);
    const panel1 = await service.upsertPatchPanel(tenantId, ACTOR, null, { rackId: id('rackA'), name: 'PP-01', ports: 24, media: 'cat6a', connector: 'rj45', uPosition: 40 });
    const panel2 = await service.upsertPatchPanel(tenantId, ACTOR, null, { rackId: id('rackB'), name: 'PP-01', ports: 24, media: 'cat6a', connector: 'rj45', uPosition: 40 });
    expect(panel1).toMatchObject({ rackCiId: id('rackA'), name: 'PP-01', ports: 24, uPosition: 40, used: 0 });
    expect(panel1.positions).toHaveLength(24);
    await expect(service.upsertPatchPanel(tenantId, ACTOR, null, { rackId: id('rackA'), name: 'PP-01', ports: 24, media: 'cat6a', connector: 'rj45', uPosition: 39 })).rejects.toThrow(/already exists/);

    const sw = { ciId: id('switch'), port: 'Gi1/0/1', side: null };
    const p1front = { ciId: panel1.ci.id, port: '1', side: 'front' as const };
    const cable = (label: string, a: typeof sw | typeof p1front, b: typeof sw | typeof p1front, kind: 'patch' | 'trunk' = 'patch') =>
      service.connectCable(tenantId, ACTOR, { label, kind, media: 'cat6a', lengthM: 2, colour: 'blue', a, b });
    const patch1 = await cable('ITEST-C-0001', sw, p1front);
    expect(patch1).toMatchObject({ label: 'ITEST-C-0001', kind: 'patch', media: 'cat6a', a: sw, b: p1front });
    await cable('ITEST-T-0001', { ciId: panel1.ci.id, port: '1', side: 'rear' }, { ciId: panel2.ci.id, port: '1', side: 'rear' }, 'trunk');
    await cable('ITEST-C-0002', { ciId: panel2.ci.id, port: '1', side: 'front' }, { ciId: id('server'), port: 'eth0', side: null });

    await expect(cable('ITEST-C-0003', { ciId: id('switch'), port: 'Gi1/0/2', side: null }, p1front)).rejects.toThrow(/already has ITEST-C-0001/);
    await expect(cable('ITEST-C-0004', { ciId: id('switch'), port: 'Gi1/0/3', side: null }, { ciId: panel1.ci.id, port: '25', side: 'front' })).rejects.toThrow(/1 to 24/);
    await expect(cable('ITEST-C-0005', { ciId: id('switch'), port: 'Gi1/0/3', side: null }, { ciId: panel1.ci.id, port: '2', side: null })).rejects.toThrow(/needs a side/);
    await service.upsertPatchPanel(tenantId, ACTOR, panel2.ci.id, { rackId: id('rackB'), name: 'PP-01', ports: 24, media: 'cat6a', connector: 'rj45', uPosition: 38 });

    const forward = await service.trace(tenantId, sw);
    expect(forward.complete).toBe(true);
    expect(forward.hops.map((h) => h.viaKind)).toEqual(['cable', 'cable', 'cable']);
    expect(forward.hops.at(-1)?.to).toEqual({ ciId: id('server'), port: 'eth0', side: null });
    const back = await service.trace(tenantId, { ciId: id('server'), port: 'eth0', side: null });
    expect(back.hops.at(-1)?.to).toEqual(sw);

    const circuit = await service.upsertCircuit(tenantId, ACTOR, null, {
      provider: 'ITEST Telecom', circuitId: 'ITEST-MPLS-' + tenantId.slice(0, 6), kind: 'mpls', status: 'active', bandwidthMbps: 1000,
      aEnd: { ciId: panel2.ci.id, port: '2', side: 'rear' }, zEnd: null, zEndDescription: 'Provider POP, Olaya',
    });
    expect(circuit).toMatchObject({ provider: 'ITEST Telecom', kind: 'mpls', status: 'active', bandwidthMbps: 1000, zEnd: null, zEndDescription: 'Provider POP, Olaya' });
    expect(circuit.aEnd).toEqual({ ciId: panel2.ci.id, port: '2', side: 'rear' });
    // The circuit holds position 2, so panel 2 cannot shrink to one position.
    await expect(service.upsertPatchPanel(tenantId, ACTOR, panel2.ci.id, { rackId: id('rackB'), name: 'PP-01', ports: 1, media: 'cat6a', connector: 'rj45', uPosition: 38 })).rejects.toThrow(/position 2/);

    const cabling = await service.cabling(tenantId);
    expect(cabling.summary).toMatchObject({ patchPanels: 2, positions: 48, cables: 3, crossConnects: 0, circuits: 1 });
    const p2 = cabling.patchPanels.find((p) => p.ci.id === panel2.ci.id);
    expect(p2).toMatchObject({ used: 2, uPosition: 38 });
    expect(p2?.positions[0]?.front?.label).toBe('ITEST-C-0002');
    expect(p2?.positions[0]?.rear?.label).toBe('ITEST-T-0001');

    expect(await service.disconnectCable(tenantId, ACTOR, patch1.ci.id)).toBe(true);
    const after = await service.trace(tenantId, { ciId: id('server'), port: 'eth0', side: null });
    expect(after.hops.map((h) => h.viaCiId)).not.toContain(patch1.ci.id);
    expect(after.complete).toBe(false);
    expect((await service.cabling(tenantId)).summary.cables).toBe(2);
    const ends = await prisma.relationship.count({ where: { tenantId, fromCiId: patch1.ci.id, validTo: null } });
    expect(ends).toBe(0);

    // A panel with a cable on it stays; a circuit is removed with its terminations; a bare panel is removed.
    await expect(service.removePatchPanel(tenantId, ACTOR, panel1.ci.id)).rejects.toThrow(/disconnect them first/);
    expect(await service.removeCircuit(tenantId, ACTOR, circuit.ci.id)).toBe(true);
    const spare = await service.upsertPatchPanel(tenantId, ACTOR, null, { rackId: id('rackA'), name: 'PP-02', ports: 12, media: 'os2', connector: 'lc', uPosition: null });
    expect(spare.uPosition).toBeNull();
    expect(await service.removePatchPanel(tenantId, ACTOR, spare.ci.id)).toBe(true);
    expect((await service.cabling(tenantId)).summary).toMatchObject({ patchPanels: 2, circuits: 0, cables: 2 });

    const audits = await prisma.outboxEvent.findMany({ where: { tenantId, type: 'openmap.audit.action' }, select: { envelope: true } });
    const actions = audits.map((a) => (a.envelope as { data: { action: string } }).data.action);
    expect(new Set(actions)).toEqual(new Set(['cabling.panel.saved', 'cabling.cable.connected', 'cabling.circuit.saved', 'cabling.cable.disconnected', 'cabling.circuit.removed', 'cabling.panel.removed']));
  }, TIMEOUT_MS);
});
