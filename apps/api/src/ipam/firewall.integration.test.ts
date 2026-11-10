// T-560 REQ-IPAM-005 (ADR-064) — firewall rules and policy objects against the compose stack, in a tenant of its own:
// - a zone-based firewall (fwi-pa-01) with address and service groups and five rules: trust→dmz web allowed through
//   the groups, a narrower copy of it nothing has hit (shadowed and unused), an untrust→trust deny, a forgotten
//   trust→dmz any-any allow (permissive) and the cleanup deny; one group no rule names;
// - a host (fwi-web-01) with an nftables input chain as the SSH collector reports it: established traffic, SSH from an
//   admin set, a logged final drop and the chain's drop policy;
// - the policy read lists rules in order with the findings, chains and objects with their use; the traffic check names
//   the deciding rule per device and chain and the rules it could not tell; GraphQL serves the same through its
//   resolvers, and refuses an address that is not one.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { loadEnv } from '@openmap/config';
import { createPrismaClient } from '@openmap/db';
import { AppModule } from '../app.module.js';
import { JWKS, realmUrl } from '../auth/jwks.provider.js';
import { SIGNING_ALGORITHM } from '../auth/auth.service.js';
import { ROLES } from '../auth/roles.js';
import { FirewallService } from './firewall.service.js';

process.env['IMPACT_VALIDATION_INTERVAL_MS'] = '0';
process.env['ANOMALY_INTERVAL_MS'] = '0';
const env = loadEnv();
const prisma = createPrismaClient(env);
const TIMEOUT_MS = 120_000;
const KID = 'openmap-firewall-key';
const organizationId = randomUUID();
const tenantId = randomUUID();
let app: NestFastifyApplication;
let token = '';

type SeedType = 'network_device' | 'host' | 'firewall_rule' | 'firewall_object';
const LAYER: Record<SeedType, 'network_security' | 'hardware'> = {
  network_device: 'network_security',
  host: 'hardware',
  firewall_rule: 'network_security',
  firewall_object: 'network_security',
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
      code: 'FWI-' + id.slice(0, 6).toUpperCase(),
      layer: LAYER[type],
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

async function rel(type: 'contains' | 'depends_on', from: string, to: string): Promise<void> {
  const now = new Date();
  await prisma.relationship.create({
    data: {
      id: randomUUID(),
      tenantId,
      type,
      fromCiId: from,
      toCiId: to,
      attributes: {},
      sourceCollectorId: 'itest',
      sourceNodeId: 'itest',
      sourceRunId: randomUUID(),
      sourceConfidence: 1,
      observedAt: now,
      validFrom: now,
    },
  });
}

async function graphql<T>(
  query: string,
  variables: Record<string, unknown>,
): Promise<{ data: T | null; errors: Array<{ message: string }> }> {
  const res = await app.inject({
    method: 'POST',
    url: '/graphql',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    payload: { query, variables },
  });
  const body = JSON.parse(res.body) as { data?: T | null; errors?: Array<{ message: string }> };
  return { data: body.data ?? null, errors: body.errors ?? [] };
}

describe('firewall rules and policy objects (integration)', () => {
  const ids: Record<string, string> = {};
  const id = (k: string): string => ids[k] ?? '';

  beforeAll(async () => {
    const keys = await generateKeyPair(SIGNING_ALGORITHM);
    const jwk = { ...(await exportJWK(keys.publicKey)), kid: KID, alg: SIGNING_ALGORITHM, use: 'sig' };
    token = await new SignJWT({
      tenant: tenantId,
      preferred_username: 'firewall',
      realm_access: { roles: [ROLES.analyst] },
      azp: env.KEYCLOAK_CLIENT_ID,
    })
      .setProtectedHeader({ alg: SIGNING_ALGORITHM, kid: KID })
      .setIssuer(realmUrl(env).toString())
      .setSubject('firewall-' + randomUUID())
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(keys.privateKey);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(JWKS)
      .useValue(createLocalJWKSet({ keys: [jwk] }))
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
      logger: ['error', 'warn'],
    });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    await prisma.organization.create({
      data: {
        id: organizationId,
        name: 'Firewall org',
        industry: 'test',
        timeZone: 'UTC',
        defaultLocale: 'en',
        regulatoryScope: [],
        airGapped: true,
      },
    });
    await prisma.tenant.create({
      data: { id: tenantId, organizationId, name: 'Firewall BU', slug: 'fwi-' + tenantId.slice(0, 8) },
    });

    ids['pa'] = await ci('network_device', 'fwi-pa-01', { serialNumber: 'FWI-PA-' + tenantId.slice(0, 6) });
    const paRef = 'serial:FWI-PA';
    const object = async (key: string, name: string, kind: string, elements: string[]) => {
      ids[key] = await ci(
        'firewall_object',
        'fwi-pa-01 ' + name,
        { deviceRef: paRef, objectId: 'shared/' + name },
        { objectId: 'shared/' + name, name, kind, elements },
      );
      await rel('contains', id('pa'), id(key));
    };
    await object('netTrust', 'net-trust', 'address', ['10.1.0.0/24', '10.1.1.0/24']);
    await object('svcWeb', 'svc-web', 'service', ['tcp/80', 'tcp/443']);
    await object('netLegacy', 'net-legacy', 'address', ['10.9.0.0/24']);
    const paRule = async (key: string, ruleId: string, attributes: Record<string, unknown>) => {
      ids[key] = await ci(
        'firewall_rule',
        'fwi-pa-01 rule ' + ruleId,
        { deviceRef: paRef, ruleId },
        { ruleId, position: Number(ruleId) / 10, enabled: true, logging: true, ...attributes },
      );
      await rel('contains', id('pa'), id(key));
    };
    await paRule('web', '10', {
      name: 'trust-to-dmz-web',
      action: 'allow',
      fromZone: 'trust',
      toZone: 'dmz',
      source: '@net-trust',
      destination: '10.2.0.0/24',
      service: '@svc-web',
      hitCount: 100,
    });
    await rel('depends_on', id('web'), id('netTrust'));
    await rel('depends_on', id('web'), id('svcWeb'));
    await paRule('narrow', '20', {
      name: 'trust-to-dmz-narrow',
      action: 'allow',
      fromZone: 'trust',
      toZone: 'dmz',
      source: '10.1.0.0/25',
      destination: '10.2.0.0/24',
      service: 'tcp/443',
      hitCount: 0,
    });
    await paRule('inbound', '30', {
      name: 'untrust-to-trust',
      action: 'deny',
      fromZone: 'untrust',
      toZone: 'trust',
      source: 'any',
      destination: 'any',
      service: 'any',
      hitCount: 50,
    });
    await paRule('temp', '40', {
      name: 'temp-any-allow',
      action: 'allow',
      fromZone: 'trust',
      toZone: 'dmz',
      source: 'any',
      destination: 'any',
      service: 'any',
      hitCount: 5,
      logging: false,
    });
    await paRule('cleanup', '50', {
      name: 'cleanup-deny',
      action: 'deny',
      fromZone: 'any',
      toZone: 'any',
      source: 'any',
      destination: 'any',
      service: 'any',
      hitCount: 7,
    });

    ids['web01'] = await ci('host', 'fwi-web-01', { fqdn: 'fwi-web-01.' + tenantId.slice(0, 6) + '.test' });
    const hostRef = 'fwi-web-01';
    ids['adminNets'] = await ci(
      'firewall_object',
      'fwi-web-01 admin_nets',
      { deviceRef: hostRef, objectId: 'inet/filter/admin_nets' },
      {
        objectId: 'inet/filter/admin_nets',
        name: 'admin_nets',
        kind: 'address',
        elements: ['10.20.0.0/16', '192.168.0.0/16'],
      },
    );
    await rel('contains', id('web01'), id('adminNets'));
    const input = {
      chain: 'inet filter input',
      hook: 'input',
      chainType: 'filter',
      table: 'inet filter',
      family: 'inet',
      enabled: true,
    };
    const hostRule = async (key: string, ruleId: string, attributes: Record<string, unknown>) => {
      ids[key] = await ci(
        'firewall_rule',
        'fwi-web-01 ' + ruleId,
        { deviceRef: hostRef, ruleId },
        { ruleId, ...input, ...attributes },
      );
      await rel('contains', id('web01'), id(key));
    };
    await hostRule('established', 'inet/filter/input/8', {
      position: 1,
      action: 'allow',
      conditions: ['ct state established,related'],
      source: [],
      destination: [],
      service: [],
      comment: 'return traffic',
    });
    await hostRule('ssh', 'inet/filter/input/13', {
      position: 2,
      action: 'allow',
      source: ['@admin_nets'],
      service: ['tcp/22'],
      destination: [],
      conditions: [],
      hitCount: 3,
      comment: 'ssh from admin networks',
    });
    await rel('depends_on', id('ssh'), id('adminNets'));
    await hostRule('drop', 'inet/filter/input/19', {
      position: 3,
      action: 'deny',
      logging: true,
      source: [],
      destination: [],
      service: [],
      conditions: [],
      hitCount: 12,
    });
    await hostRule('policy', 'inet/filter/input/policy', {
      position: 4,
      action: 'deny',
      isPolicy: true,
      source: [],
      destination: [],
      service: [],
      conditions: [],
    });
  }, TIMEOUT_MS);

  afterAll(async () => {
    await prisma.outboxEvent.deleteMany({ where: { tenantId } });
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    if (app !== undefined) await app.close();
    await prisma.$disconnect();
  }, TIMEOUT_MS);

  it('lists a zone-based policy in order with shadowed, unused and permissive rules and the group no rule names', async () => {
    const view = await app.get(FirewallService).policy(tenantId, id('pa'));
    expect(view.rules.map((r) => r.ruleId)).toEqual(['10', '20', '30', '40', '50']);
    expect(view.summary).toEqual({
      rules: 5,
      allow: 3,
      deny: 2,
      nat: 0,
      objects: 3,
      shadowed: 1,
      unused: 1,
      permissive: 1,
      unusedObjects: 1,
    });
    const narrow = view.rules.find((r) => r.ruleId === '20');
    expect(narrow?.findings).toEqual([
      { kind: 'shadowed', byRuleId: '10', byName: 'trust-to-dmz-web', sameAction: true },
      { kind: 'unused', byRuleId: null, byName: null, sameAction: null },
    ]);
    expect(view.rules.find((r) => r.ruleId === '40')?.findings.map((f) => f.kind)).toEqual(['permissive']);
    expect(view.chains).toEqual([{ name: '', hook: null, chainType: null, rules: 5, policy: null }]);
    expect(view.objects.map((o) => [o.name, o.ruleCount, o.unused])).toEqual([
      ['net-legacy', 0, true],
      ['net-trust', 1, false],
      ['svc-web', 1, false],
    ]);
  });

  it('decides a connection per device and chain, and lists the rules it could not tell without zones', async () => {
    const service = app.get(FirewallService);
    const zoned = await service.check(tenantId, {
      source: '10.1.0.9',
      destination: '10.2.0.5',
      protocol: 'tcp',
      port: 443,
      deviceId: null,
      fromZone: 'trust',
      toZone: 'dmz',
    });
    expect(zoned.evaluated).toBe(2);
    expect(zoned.truncated).toBe(false);
    const pa = zoned.results.find((r) => r.deviceId === id('pa'));
    expect(pa).toMatchObject({ chain: '', verdict: 'allow', rule: { ruleId: '10' }, uncertain: [] });
    const host = zoned.results.find((r) => r.deviceId === id('web01'));
    expect(host).toMatchObject({
      chain: 'inet filter input',
      verdict: 'deny',
      rule: { ruleId: 'inet/filter/input/19' },
      path: ['inet filter input'],
    });
    const ssh = await service.check(tenantId, {
      source: '10.20.3.4',
      destination: '10.1.0.20',
      protocol: 'tcp',
      port: 22,
      deviceId: id('web01'),
    });
    expect(ssh.results).toHaveLength(1);
    expect(ssh.results[0]).toMatchObject({ verdict: 'allow', rule: { comment: 'ssh from admin networks' } });
    const noZones = await service.check(tenantId, {
      source: '10.1.0.9',
      destination: '10.2.0.5',
      protocol: 'tcp',
      port: 443,
      deviceId: id('pa'),
    });
    expect(noZones.results[0]).toMatchObject({ verdict: 'deny', rule: { ruleId: '50' } });
    expect(noZones.results[0]?.uncertain.map((r) => r.ruleId)).toEqual(['10', '20', '30', '40']);
    await expect(service.policy(tenantId, randomUUID())).rejects.toThrow(/no firewall rules/u);
  });

  it('serves devices, a host policy and a check over GraphQL, and refuses an address that is not one', async () => {
    const devices = await graphql<{
      firewallDevices: Array<{ rules: number; objects: number; device: { name: string } }>;
    }>('query D($t: String) { firewallDevices(text: $t) { rules objects device { name } } }', { t: 'FWI' });
    expect(devices.errors).toEqual([]);
    expect(devices.data?.firewallDevices).toEqual([
      { rules: 5, objects: 3, device: { name: 'fwi-pa-01' } },
      { rules: 4, objects: 1, device: { name: 'fwi-web-01' } },
    ]);
    const policy = await graphql<{
      firewallPolicy: {
        device: { name: string };
        chains: Array<{ name: string; hook: string; rules: number; policy: string }>;
        rules: Array<{ position: number; action: string; rule: { id: string }; isPolicy: boolean }>;
      };
    }>(
      'query P($id: UUID!) { firewallPolicy(deviceId: $id) { device { name } chains { name hook rules policy } rules { position action isPolicy rule { id } } } }',
      { id: id('web01') },
    );
    expect(policy.errors).toEqual([]);
    expect(policy.data?.firewallPolicy.device.name).toBe('fwi-web-01');
    expect(policy.data?.firewallPolicy.chains).toEqual([
      { name: 'inet filter input', hook: 'input', rules: 3, policy: 'deny' },
    ]);
    expect(policy.data?.firewallPolicy.rules.map((r) => r.rule.id)).toEqual([
      id('established'),
      id('ssh'),
      id('drop'),
      id('policy'),
    ]);
    const check = await graphql<{
      firewallCheck: {
        results: Array<{ verdict: string; device: { name: string }; rule: { name: string } | null }>;
      };
    }>(
      'query C($input: FirewallCheckInput!) { firewallCheck(input: $input) { results { verdict device { name } rule { name } } } }',
      {
        input: {
          source: '10.20.3.4',
          destination: '10.1.0.20',
          protocol: 'TCP',
          port: 22,
          deviceId: id('web01'),
        },
      },
    );
    expect(check.errors).toEqual([]);
    expect(check.data?.firewallCheck.results).toEqual([
      { verdict: 'allow', device: { name: 'fwi-web-01' }, rule: { name: 'fwi-web-01 inet/filter/input/13' } },
    ]);
    const bad = await graphql(
      'query C($input: FirewallCheckInput!) { firewallCheck(input: $input) { evaluated } }',
      { input: { source: 'not-an-ip', destination: '10.1.0.20', protocol: 'tcp' } },
    );
    expect(bad.errors.length).toBeGreaterThan(0);
  });
});
