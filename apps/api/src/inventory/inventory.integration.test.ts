// T-624 REQ-INT-011 (ADR-072) — the inventory routes against the compose stack, in a tenant of its own (estate.ts):
// - every route needs a token, and an analyst's or an automation client's token reads;
// - Ansible: the inventory types and default lifecycles only, hostvars with ansible_host from the management IP, the
//   site from the located_in chain (or the collector's site attribute), the business service through the application
//   and its component on the VM, the host and its hypervisor merged into one node, groups by site, type, tag, service;
// - filters by site, tag, type, layer, lifecycle and business service (id or code), and a bad facet is a 400;
// - salt-ssh: the roster in YAML by default and as JSON on request, user, port and sudo applied;
// - Puppet: the ENC document of one certname (any case) in YAML, classes from puppetClasses, the CI's environment, 404
//   for a certname no CI has; every node by certname as JSON;
// - Chef: nodes with their site and service roles in the run list, each role once;
// - the inventory counters and the REST counters move by tool and route.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type GenerateKeyPairResult } from 'jose';
import { loadEnv } from '@openmap/config';
import { INVENTORY } from '@openmap/constants';
import { createPrismaClient } from '@openmap/db';
import { OpenMapClient } from '@openmap/sdk';
import { AppModule } from '../app.module.js';
import { JWKS, realmUrl } from '../auth/jwks.provider.js';
import { SIGNING_ALGORITHM } from '../auth/auth.service.js';
import { ROLES } from '../auth/roles.js';
import { MetricsService } from '../metrics/metrics.service.js';
import { createEstate, dropEstate, ESTATE, type Estate } from './__tests__/estate.js';

process.env['IMPACT_VALIDATION_INTERVAL_MS'] = '0';
const env = loadEnv();
const prisma = createPrismaClient(env);
const KID = 'openmap-inventory-key';
const TIMEOUT_MS = 120_000;

let app: NestFastifyApplication;
let keys: GenerateKeyPairResult;
let baseUrl = '';
let estate: Estate | undefined;

function token(
  tenant: string,
  roles: string[],
  claims: Record<string, unknown> = { azp: env.KEYCLOAK_CLIENT_ID },
): Promise<string> {
  return new SignJWT({ tenant, preferred_username: 'inventory-user', realm_access: { roles }, ...claims })
    .setProtectedHeader({ alg: SIGNING_ALGORITHM, kid: KID })
    .setIssuer(realmUrl(env).toString())
    .setSubject('inventory-' + randomUUID())
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(keys.privateKey);
}

function tenant(): string {
  if (estate === undefined) throw new Error('estate not created');
  return estate.tenantId;
}

async function get(path: string, bearer: string | null): Promise<Response> {
  return fetch(
    baseUrl + '/api/v1/inventory' + path,
    bearer === null ? {} : { headers: { authorization: 'Bearer ' + bearer } },
  );
}

describe('configuration-management inventory (integration)', () => {
  let sdk: OpenMapClient;

  beforeAll(async () => {
    keys = await generateKeyPair(SIGNING_ALGORITHM);
    const jwk = { ...(await exportJWK(keys.publicKey)), kid: KID, alg: SIGNING_ALGORITHM, use: 'sig' };
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(JWKS)
      .useValue(createLocalJWKSet({ keys: [jwk] }))
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
      logger: ['error', 'warn'],
    });
    await app.init();
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
    estate = await createEstate(prisma);
    sdk = new OpenMapClient({ baseUrl, token: () => token(tenant(), [ROLES.analyst]) });
  }, TIMEOUT_MS);

  afterAll(async () => {
    await dropEstate(prisma, estate);
    if (app !== undefined) await app.close();
    await prisma.$disconnect();
  }, TIMEOUT_MS);

  it('needs a token, and reads with an automation client token', async () => {
    for (const path of ['/ansible', '/salt', '/puppet', '/puppet/nodes/' + ESTATE.app, '/chef'])
      expect((await get(path, null)).status).toBe(401);
    const automation = await token(tenant(), [ROLES.operator], {
      azp: 'openmap-automation',
      aud: [env.KEYCLOAK_API_CLIENT_ID],
    });
    expect((await get('/ansible', automation)).status).toBe(200);
  });

  it('answers the Ansible dynamic inventory with merged nodes, sites, services and groups', async () => {
    const inv = await sdk.inventory.ansible();
    const hosts = Object.keys(inv._meta.hostvars).sort();
    expect(hosts).toEqual([ESTATE.switch, ESTATE.app, ESTATE.esx, ESTATE.batch, ESTATE.web].sort());
    const hv = inv._meta.hostvars;
    expect(hv[ESTATE.app]).toMatchObject({
      ansible_host: ESTATE.appIp,
      openmap_type: 'host',
      openmap_site: ESTATE.site,
      openmap_tags: ['linux', 'pci'],
      openmap_services: [],
      openmap_attributes: { osName: 'RHEL', osVersion: '9.4' },
    });
    expect(hv[ESTATE.esx]).toMatchObject({
      ansible_host: ESTATE.esxIp,
      openmap_type: 'host',
      openmap_merged_ids: [estate?.ids.hypervisor],
      openmap_tags: ['hypervisor', 'vmware'],
      openmap_site: ESTATE.site,
    });
    expect(hv[ESTATE.web]).toMatchObject({
      ansible_host: ESTATE.web,
      openmap_site: ESTATE.site,
      openmap_services: [{ id: estate?.ids.service, code: ESTATE.serviceCode, name: ESTATE.serviceName }],
    });
    expect(hv[ESTATE.batch]).toMatchObject({
      ansible_host: ESTATE.batchIp,
      openmap_site: ESTATE.fallbackSite,
    });
    expect(hv[ESTATE.switch]).toMatchObject({
      ansible_host: ESTATE.switchIp,
      openmap_type: 'network_device',
      openmap_attributes: { manufacturer: 'Arista', model: '7050X' },
    });
    // The hypervisor reaches the service through the VM it runs, and so does the host it is merged into.
    expect(inv['service_bs_payments']).toMatchObject({
      hosts: [ESTATE.esx, ESTATE.web].sort(),
      vars: { openmap_service_code: ESTATE.serviceCode },
    });
    expect(inv['site_ryd']?.hosts?.sort()).toEqual([ESTATE.app, ESTATE.esx, ESTATE.web].sort());
    expect(inv['site_jed']?.hosts).toEqual([ESTATE.batch]);
    expect(inv['tag_pci']?.hosts).toEqual([ESTATE.app]);
    expect(inv['type_network_device']?.hosts).toEqual([ESTATE.switch]);
    expect(inv.all.children).toEqual([
      'ungrouped',
      'openmap_site',
      'openmap_type',
      'openmap_tag',
      'openmap_service',
    ]);
    expect(inv['ungrouped']?.hosts).toEqual([]);
  });

  it('filters by site, tag, type, layer, lifecycle and service, and refuses an unknown facet', async () => {
    const names = async (query: Parameters<typeof sdk.inventory.ansible>[0]): Promise<string[]> =>
      Object.keys((await sdk.inventory.ansible(query))._meta.hostvars).sort();
    expect(await names({ sites: ESTATE.site.toLowerCase() })).toEqual(
      [ESTATE.app, ESTATE.esx, ESTATE.web].sort(),
    );
    expect(await names({ tags: 'linux,pci' })).toEqual([ESTATE.app]);
    expect(await names({ types: 'vm' })).toEqual([ESTATE.batch, ESTATE.web].sort());
    expect(await names({ layers: 'network_security' })).toEqual([ESTATE.switch]);
    expect(await names({ services: ESTATE.serviceCode.toLowerCase() })).toEqual(
      [ESTATE.esx, ESTATE.web].sort(),
    );
    expect(await names({ services: estate?.ids.service ?? '' })).toEqual([ESTATE.esx, ESTATE.web].sort());
    expect(await names({ lifecycle: 'retired' })).toEqual([ESTATE.retired]);
    expect(await names({ types: 'database' })).toEqual(['payments-db']);
    const grouped = await sdk.inventory.ansible({ groupBy: 'layer,lifecycle', attributes: 'guestOs' });
    expect(grouped.all.children).toEqual(['ungrouped', 'openmap_layer', 'openmap_lifecycle']);
    expect(grouped._meta.hostvars[ESTATE.web]).toMatchObject({
      openmap_attributes: { guestOs: 'Ubuntu 24.04' },
    });
    expect((await get('/ansible?groupBy=colour', await token(tenant(), [ROLES.analyst]))).status).toBe(400);
  });

  it('writes the salt-ssh roster in YAML, and as JSON with user, port and sudo', async () => {
    const res = await get('/salt?user=ops', await token(tenant(), [ROLES.analyst]));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/yaml');
    const yaml = await res.text();
    expect(yaml.startsWith('---\n')).toBe(true);
    expect(yaml).toContain('"' + ESTATE.app + '":\n  host: "' + ESTATE.appIp + '"\n  user: "ops"\n');
    const roster = await sdk.inventory.salt({ user: 'ops', port: 2222, sudo: 'true' });
    expect(roster[ESTATE.web]).toMatchObject({
      host: ESTATE.web,
      user: 'ops',
      port: 2222,
      sudo: true,
      minion_opts: { grains: { openmap: { site: ESTATE.site, services: [{ code: ESTATE.serviceCode }] } } },
    });
  });

  it('classifies one Puppet node by certname, and lists every node', async () => {
    const res = await get(
      '/puppet/nodes/' + ESTATE.app.toUpperCase(),
      await token(tenant(), [ROLES.analyst]),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/yaml');
    expect(await res.text()).toMatch(
      /^---\nclasses:\n {2}"role::app": \{\}\n {2}"profile::base": \{\}\nparameters:\n/u,
    );
    const node = await sdk.inventory.puppetNode(ESTATE.app);
    expect(node).toMatchObject({
      classes: { 'role::app': {}, 'profile::base': {} },
      environment: 'staging',
      parameters: { openmap_id: estate?.ids.app, openmap_site: ESTATE.site },
    });
    expect((await sdk.inventory.puppetNode(ESTATE.switch, { environment: 'qa' })).environment).toBe('qa');
    expect((await sdk.inventory.puppetNode(ESTATE.batch)).environment).toBe(
      INVENTORY.puppetDefaultEnvironment,
    );
    await expect(sdk.inventory.puppetNode('nobody.inv.test')).rejects.toMatchObject({ status: 404 });
    const all = await sdk.inventory.puppet({ sites: ESTATE.site });
    expect(Object.keys(all.nodes).sort()).toEqual([ESTATE.app, ESTATE.esx, ESTATE.web].sort());
  });

  it('exports Chef nodes with their site and service roles', async () => {
    const out = await sdk.inventory.chef({ environment: 'ops' });
    expect(out.roles.map((r) => r.name)).toEqual([
      'openmap_service_bs_payments',
      'openmap_site_jed',
      'openmap_site_ryd',
    ]);
    expect(out.nodes.find((n) => n.name === ESTATE.web)).toMatchObject({
      chef_environment: 'ops',
      run_list: ['role[openmap_site_ryd]', 'role[openmap_service_bs_payments]'],
      normal: { openmap: { id: estate?.ids.web } },
    });
    expect(out.nodes.find((n) => n.name === ESTATE.app)?.chef_environment).toBe('prod');
    expect(out.nodes.find((n) => n.name === ESTATE.switch)?.run_list).toEqual([]);
  });

  it('counts documents and nodes by tool, and calls by route and status', async () => {
    const metrics = app.get(MetricsService).registry;
    const exports = await metrics.getSingleMetricAsString('openmap_inventory_exports_total');
    for (const tool of ['ansible', 'salt', 'puppet', 'chef'])
      expect(exports).toContain('tool="' + tool + '"');
    expect(await metrics.getSingleMetricAsString('openmap_inventory_nodes_total')).toContain(
      'tool="ansible"',
    );
    const rest = await metrics.getSingleMetricAsString('openmap_rest_requests_total');
    expect(rest).toContain('route="ansibleInventory",status="200"');
    expect(rest).toContain('route="ansibleInventory",status="400"');
    expect(rest).toContain('route="puppetNode",status="404"');
    expect(rest).toContain('route="chefExport",status="200"');
  });
});
