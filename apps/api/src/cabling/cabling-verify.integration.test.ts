// T-551 REQ-DCIM-008 (ADR-062) — cable verification against the compose stack, in a tenant of its own:
// - discovery observed three adjacencies: sw1 Ethernet1 ↔ sw2 Ethernet5 and sw1 Ethernet2 ↔ sw3 Ethernet9 (LLDP between
//   interfaces) and the server's eno1 on sw1 Ethernet7 (`cabled_to`);
// - people recorded seven cables: a direct lead that matches the first adjacency (verified), a lead from sw1 Ethernet2
//   to the wrong switch (mismatch), the server's lead (verified through `cabled_to`), a three-cable path through two
//   patch panels nobody observed (unobserved, all three), and a lead to a panel position with nothing behind it
//   (unverifiable, path incomplete);
// - the adjacency to sw3 is undocumented and carries the label a recorded cable would get;
// - the labels CSV lists every cable with both ends and its status.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { loadEnv } from '@openmap/config';
import { createPrismaClient } from '@openmap/db';
import { AppModule } from '../app.module.js';
import { CablingService } from './cabling.service.js';
import { CablingVerificationService } from './cabling-verify.service.js';

process.env['IMPACT_VALIDATION_INTERVAL_MS'] = '0';
process.env['ANOMALY_INTERVAL_MS'] = '0';
const env = loadEnv();
const prisma = createPrismaClient(env);
const TIMEOUT_MS = 120_000;
const organizationId = randomUUID();
const tenantId = randomUUID();
const ACTOR = 'verify-itest';
let app: NestFastifyApplication;

type SeedType = 'rack' | 'network_device' | 'host' | 'interface';
const LAYER = {
  rack: 'dc',
  network_device: 'network_security',
  host: 'hardware',
  interface: 'network_security',
} as const;

async function ci(type: SeedType, name: string, identity: Record<string, string>): Promise<string> {
  const id = randomUUID();
  const now = new Date();
  await prisma.ci.create({
    data: {
      id,
      tenantId,
      type,
      identity,
      identityKey: Object.values(identity).join('|'),
      name,
      displayName: name,
      code: 'VER-' + id.slice(0, 6).toUpperCase(),
      layer: LAYER[type],
      lifecycle: 'discovered',
      attributes: {},
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
  type: 'contains' | 'connected_to' | 'cabled_to',
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

describe('cable verification (integration)', () => {
  const ids: Record<string, string> = {};
  const id = (k: string): string => ids[k] ?? '';
  /** A switch with the named interfaces, each contained by it. */
  async function switchWith(key: string, name: string, ports: readonly string[]): Promise<void> {
    ids[key] = await ci('network_device', name, { serialNumber: 'SN-' + name + '-' + tenantId.slice(0, 6) });
    for (const port of ports) {
      ids[key + ':' + port] = await ci('interface', name + ' ' + port, {
        deviceRef: 'serial:' + name,
        name: port,
      });
      await rel('contains', id(key), id(key + ':' + port));
    }
  }
  const lead = (
    label: string,
    a: [string, string, ('front' | 'rear')?],
    b: [string, string, ('front' | 'rear')?],
    kind: 'patch' | 'trunk' = 'patch',
  ) =>
    app
      .get(CablingService)
      .connectCable(tenantId, ACTOR, {
        label,
        kind,
        media: 'cat6a',
        lengthM: 2,
        colour: 'blue',
        a: { ciId: id(a[0]), port: a[1], side: a[2] ?? null },
        b: { ciId: id(b[0]), port: b[1], side: b[2] ?? null },
      });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
      logger: ['error', 'warn'],
    });
    await app.init();
    await prisma.organization.create({
      data: {
        id: organizationId,
        name: 'Verify org',
        industry: 'test',
        timeZone: 'UTC',
        defaultLocale: 'en',
        regulatoryScope: [],
        airGapped: true,
      },
    });
    await prisma.tenant.create({
      data: { id: tenantId, organizationId, name: 'Verify BU', slug: 'verify-' + tenantId.slice(0, 8) },
    });
    ids['rack'] = await ci('rack', 'VER-R01', { roomRef: 'VER-DH01', name: 'R01' });
    await switchWith('sw1', 'ver-sw1', ['Ethernet1', 'Ethernet2', 'Ethernet7']);
    await switchWith('sw2', 'ver-sw2', ['Ethernet5']);
    await switchWith('sw3', 'ver-sw3', ['Ethernet9']);
    ids['server'] = await ci('host', 'ver-srv-01', { serialNumber: 'SN-SRV-' + tenantId.slice(0, 6) });
    // What discovery observed.
    await rel('connected_to', id('sw1:Ethernet1'), id('sw2:Ethernet5'), {
      protocol: 'lldp',
      media: '10GBASE-SR',
      speedMbps: 10_000,
    });
    await rel('connected_to', id('sw1:Ethernet2'), id('sw3:Ethernet9'), {
      protocol: 'lldp',
      speedMbps: 10_000,
    });
    await rel('cabled_to', id('server'), id('sw1:Ethernet7'), { hostNic: 'eno1', speedMbps: 10_000 });
    // What people recorded.
    const cabling = app.get(CablingService);
    ids['panel1'] = (
      await cabling.upsertPatchPanel(tenantId, ACTOR, null, {
        rackId: id('rack'),
        name: 'PP-01',
        ports: 24,
        media: 'cat6a',
        connector: 'rj45',
        uPosition: 40,
      })
    ).ci.id;
    ids['panel2'] = (
      await cabling.upsertPatchPanel(tenantId, ACTOR, null, {
        rackId: id('rack'),
        name: 'PP-02',
        ports: 24,
        media: 'cat6a',
        connector: 'rj45',
        uPosition: 41,
      })
    ).ci.id;
    await lead('C-OK', ['sw1', 'Ethernet1'], ['sw2', 'Ethernet5']);
    await lead('C-WRONG', ['sw1', 'Ethernet2'], ['sw2', 'Ethernet8']);
    await lead('C-SERVER', ['server', 'eno1'], ['sw1', 'Ethernet7']);
    await lead('C-P1', ['sw1', 'Ethernet3'], ['panel1', '1', 'front']);
    await lead('C-TRUNK', ['panel1', '1', 'rear'], ['panel2', '1', 'rear'], 'trunk');
    await lead('C-P2', ['panel2', '1', 'front'], ['sw2', 'Ethernet6']);
    await lead('C-OPEN', ['sw2', 'Ethernet10'], ['panel1', '2', 'front']);
  }, TIMEOUT_MS);

  afterAll(async () => {
    await prisma.outboxEvent.deleteMany({ where: { tenantId } });
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    if (app !== undefined) await app.close();
    await prisma.$disconnect();
  }, TIMEOUT_MS);

  it('judges every recorded cable against the observed adjacencies and lists the undocumented link', async () => {
    const view = await app.get(CablingVerificationService).verification(tenantId);
    expect(view.summary).toEqual({
      cables: 7,
      verified: 2,
      mismatch: 1,
      unobserved: 3,
      unverifiable: 1,
      undocumented: 1,
    });
    const byLabel = new Map(view.cables.map((c) => [c.cable.label, c]));
    expect(byLabel.get('C-OK')).toMatchObject({ status: 'verified', reason: 'observed' });
    expect(byLabel.get('C-OK')?.observed).toMatchObject({
      protocol: 'lldp',
      media: '10GBASE-SR',
      speedMbps: 10_000,
    });
    expect(byLabel.get('C-SERVER')).toMatchObject({ status: 'verified', reason: 'observed' });
    expect(byLabel.get('C-WRONG')).toMatchObject({ status: 'mismatch', reason: 'far_end_differs' });
    // The mismatch names what was actually seen on that port: sw3 Ethernet9.
    const seen = byLabel.get('C-WRONG')?.observed;
    expect([seen?.a.ciId, seen?.b.ciId]).toContain(id('sw3'));
    expect([seen?.a.port, seen?.b.port]).toContain('Ethernet9');
    for (const label of ['C-P1', 'C-TRUNK', 'C-P2'])
      expect(byLabel.get(label), label).toMatchObject({
        status: 'unobserved',
        reason: 'no_observation',
        observed: null,
      });
    expect(byLabel.get('C-OPEN')).toMatchObject({ status: 'unverifiable', reason: 'path_incomplete' });
    expect(view.undocumented).toHaveLength(1);
    const extra = view.undocumented[0];
    expect([extra?.a.ciId, extra?.b.ciId].sort()).toEqual([id('sw1'), id('sw3')].sort());
    expect(extra?.suggestedLabel).toBe('ver-sw1:Ethernet2 - ver-sw3:Ethernet9');
  });

  it('prints the cable labels as CSV with both ends and the status', async () => {
    const csv = await app.get(CablingVerificationService).labelsCsv(tenantId);
    const lines = csv.trim().split('\n');
    expect(lines[0]).toBe('label,kind,media,endA,endB,lengthM,colour,status');
    expect(lines).toHaveLength(8);
    expect(lines).toContain('C-OK,patch,cat6a,ver-sw1 Ethernet1,ver-sw2 Ethernet5,2,blue,verified');
    expect(lines).toContain(
      'C-TRUNK,trunk,cat6a,VER-R01 PP-01 1 rear,VER-R01 PP-02 1 rear,2,blue,unobserved',
    );
    expect(lines).toContain('C-WRONG,patch,cat6a,ver-sw1 Ethernet2,ver-sw2 Ethernet8,2,blue,mismatch');
  });
});
