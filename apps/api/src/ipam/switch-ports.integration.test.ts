// T-556 REQ-IPAM-004 (ADR-063) — switch ports against the compose stack, in a tenant of its own:
// - a ToR switch has four ports: Ethernet1 up in VLAN 204 with a server's MAC learned (the server is `cabled_to` it on
//   eno1, and its IP carries the same MAC), Ethernet2 up with an LLDP neighbour on the core switch, Ethernet3 down and
//   recorded in ClickHouse as up 60 days ago and down since 45 days ago (unused), Ethernet10 administratively down;
// - the ports come back in natural order with state, speed, VLAN, neighbour, the MAC resolved to the IP and the server,
//   and the summary counts them; Ethernet3's history shows it going down 45 days ago;
// - a MAC lookup finds the server's MAC learned on Ethernet1, in the IP's ARP record and as the server's own address.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { TIME } from '@openmap/constants';
import { loadEnv } from '@openmap/config';
import { createPrismaClient } from '@openmap/db';
import { AppModule } from '../app.module.js';
import { ClickHouseService, clickhouseTime } from '../db/clickhouse.service.js';
import { SwitchPortsService } from './switch-ports.service.js';

process.env['IMPACT_VALIDATION_INTERVAL_MS'] = '0';
process.env['ANOMALY_INTERVAL_MS'] = '0';
const env = loadEnv();
const prisma = createPrismaClient(env);
const TIMEOUT_MS = 120_000;
const organizationId = randomUUID();
const tenantId = randomUUID();
const SERVER_MAC = '00:50:56:9a:01:02';
let app: NestFastifyApplication;

type SeedType = 'network_device' | 'interface' | 'host' | 'ip_address' | 'vlan';
const LAYER: Record<SeedType, string> = {
  network_device: 'network_security',
  interface: 'network_security',
  host: 'hardware',
  ip_address: 'network_security',
  vlan: 'network_security',
};

async function ci(
  type: SeedType,
  name: string,
  identity: Record<string, string>,
  attributes: Record<string, unknown> = {},
): Promise<string> {
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
      code: 'SWP-' + id.slice(0, 6).toUpperCase(),
      layer: LAYER[type] as 'network_security',
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
  type: 'contains' | 'connected_to' | 'cabled_to' | 'uses_ip' | 'in_vlan',
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

describe('switch ports (integration)', () => {
  const ids: Record<string, string> = {};
  const id = (k: string): string => ids[k] ?? '';
  const now = Date.now();
  const port = (name: string, attributes: Record<string, unknown>) =>
    ci(
      'interface',
      'swp-tor-01 ' + name,
      { deviceRef: 'serial:SWP-TOR', name },
      { ifDescr: name, ifType: 'ethernetCsmacd', ifSpeedMbps: 10_000, ifMtu: 9216, ...attributes },
    );

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
      logger: ['error', 'warn'],
    });
    await app.init();
    await prisma.organization.create({
      data: {
        id: organizationId,
        name: 'Switch ports org',
        industry: 'test',
        timeZone: 'UTC',
        defaultLocale: 'en',
        regulatoryScope: [],
        airGapped: true,
      },
    });
    await prisma.tenant.create({
      data: { id: tenantId, organizationId, name: 'Switch ports BU', slug: 'swp-' + tenantId.slice(0, 8) },
    });
    ids['tor'] = await ci('network_device', 'swp-tor-01', {
      serialNumber: 'SWP-TOR-' + tenantId.slice(0, 6),
    });
    ids['core'] = await ci('network_device', 'swp-core-01', {
      serialNumber: 'SWP-CORE-' + tenantId.slice(0, 6),
    });
    ids['e1'] = await port('Ethernet1', {
      ifAdminStatus: 'up',
      ifOperStatus: 'up',
      ifAlias: 'swp-srv-01 eno1',
      learnedMacs: [SERVER_MAC.toUpperCase()],
      learnedMacCount: 1,
    });
    ids['e2'] = await port('Ethernet2', { ifAdminStatus: 'up', ifOperStatus: 'up', ifAlias: 'uplink core' });
    ids['e3'] = await port('Ethernet3', { ifAdminStatus: 'up', ifOperStatus: 'down', ifAlias: '' });
    ids['e10'] = await port('Ethernet10', { ifAdminStatus: 'down', ifOperStatus: 'down' });
    for (const p of ['e1', 'e2', 'e3', 'e10']) await rel('contains', id('tor'), id(p));
    ids['coreE49'] = await ci(
      'interface',
      'swp-core-01 Ethernet49',
      { deviceRef: 'serial:SWP-CORE', name: 'Ethernet49' },
      { ifOperStatus: 'up' },
    );
    await rel('contains', id('core'), id('coreE49'));
    await rel('connected_to', id('e2'), id('coreE49'), { protocol: 'lldp', speedMbps: 100_000 });
    ids['vlan'] = await ci('vlan', 'PROD-4', { deviceRef: 'serial:SWP-TOR', vlanId: '204' }, { vlanId: 204 });
    await rel('in_vlan', id('e1'), id('vlan'));
    ids['server'] = await ci(
      'host',
      'swp-srv-01',
      { serialNumber: 'SWP-SRV-' + tenantId.slice(0, 6) },
      { primaryMac: SERVER_MAC },
    );
    await rel('cabled_to', id('server'), id('e1'), { hostNic: 'eno1', speedMbps: 10_000 });
    ids['ip'] = await ci(
      'ip_address',
      '10.77.4.21',
      { address: '10.77.4.21', vrfRef: 'default' },
      { macAddress: SERVER_MAC, status: 'assigned' },
    );
    await rel('uses_ip', id('server'), id('ip'));
    // Ethernet3's recorded versions: up 60 days ago, down since 45 days ago.
    const version = (daysAgo: number, attributes: Record<string, unknown>) => ({
      tenant_id: tenantId,
      ci_id: id('e3'),
      type: 'interface',
      layer: 'network_security',
      lifecycle: 'discovered',
      name: 'swp-tor-01 Ethernet3',
      display_name: 'swp-tor-01 Ethernet3',
      identity_key: 'serial:SWP-TOR|Ethernet3',
      identity: JSON.stringify({ deviceRef: 'serial:SWP-TOR', name: 'Ethernet3' }),
      attributes: JSON.stringify({ ifDescr: 'Ethernet3', ifSpeedMbps: 10_000, ...attributes }),
      tags: [],
      user_label: '',
      source_collector_id: 'itest',
      source_node_id: 'itest',
      source_run_id: randomUUID(),
      source_confidence: 1,
      observed_at: clickhouseTime(new Date(now - daysAgo * TIME.msPerDay)),
      valid_from: clickhouseTime(new Date(now - daysAgo * TIME.msPerDay)),
      valid_to: null,
      checksum: 'c'.repeat(64),
    });
    await app
      .get(ClickHouseService)
      .insert('ci_history', [
        version(60, { ifAdminStatus: 'up', ifOperStatus: 'up', ifAlias: 'old-srv-07' }),
        version(45, { ifAdminStatus: 'up', ifOperStatus: 'down', ifAlias: '' }),
      ]);
  }, TIMEOUT_MS);

  afterAll(async () => {
    await prisma.outboxEvent.deleteMany({ where: { tenantId } });
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    if (app !== undefined) await app.close();
    await prisma.$disconnect();
  }, TIMEOUT_MS);

  it('lists the ports with state, VLAN, neighbour, resolved MACs and the unused one', async () => {
    const view = await app.get(SwitchPortsService).switchPorts(tenantId, id('tor'), new Date(now));
    expect(view.ports.map((p) => p.name)).toEqual(['Ethernet1', 'Ethernet2', 'Ethernet3', 'Ethernet10']);
    expect(view.summary).toEqual({
      ports: 4,
      up: 2,
      down: 1,
      adminDown: 1,
      unknown: 0,
      unused: 1,
      learnedMacs: 1,
    });
    const [e1, e2, e3, e10] = view.ports;
    expect(e1).toMatchObject({
      state: 'up',
      speedMbps: 10_000,
      mtu: 9216,
      vlan: 204,
      alias: 'swp-srv-01 eno1',
      learnedMacCount: 1,
      unused: false,
      daysNotUp: null,
    });
    expect(e1?.learnedMacs).toEqual([{ mac: SERVER_MAC, ip: '10.77.4.21', ownerId: id('server') }]);
    expect(e1?.neighbour).toEqual({ ciId: id('server'), port: 'eno1', protocol: 'lldp' });
    expect(e2?.neighbour).toEqual({ ciId: id('core'), port: 'Ethernet49', protocol: 'lldp' });
    expect(e3).toMatchObject({ state: 'down', daysNotUp: 45, unused: true });
    expect(e3?.lastChange).toBe(new Date(now - 45 * TIME.msPerDay).toISOString());
    expect(e10).toMatchObject({ state: 'admin_down', unused: false });
  });

  it('shows a port going down in its history, newest first', async () => {
    const history = await app.get(SwitchPortsService).portHistory(tenantId, id('e3'), 90, new Date(now));
    expect(history.versions).toBe(3);
    expect(history.changes.map((c) => [c.key, c.from, c.to])).toEqual([
      ['state', 'up', 'down'],
      ['alias', 'old-srv-07', null],
    ]);
    expect(history.changes[0]?.at).toBe(new Date(now - 45 * TIME.msPerDay).toISOString());
  });

  it("finds a MAC on the switch port, in the ARP record and as the server's own address, in any spelling", async () => {
    const lookup = await app.get(SwitchPortsService).macLookup(tenantId, '0050.569A.0102');
    expect(lookup.mac).toBe(SERVER_MAC);
    const byKind = new Map(lookup.sightings.map((s) => [s.kind, s]));
    expect(byKind.get('learned_on_port')).toMatchObject({ ciId: id('tor'), port: 'Ethernet1' });
    expect(byKind.get('arp')).toMatchObject({ ciId: id('ip'), ip: '10.77.4.21' });
    expect(byKind.get('owner')).toMatchObject({ ciId: id('server') });
    expect((await app.get(SwitchPortsService).macLookup(tenantId, 'not-a-mac')).sightings).toEqual([]);
  });

  it('refuses a device or port that does not exist', async () => {
    await expect(app.get(SwitchPortsService).switchPorts(tenantId, randomUUID())).rejects.toThrow(
      /not found/,
    );
    await expect(app.get(SwitchPortsService).portHistory(tenantId, id('tor'))).rejects.toThrow(/not found/);
  });
});
