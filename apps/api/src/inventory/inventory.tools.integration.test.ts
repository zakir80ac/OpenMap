// T-625 REQ-INT-011 (ADR-072) — the real tools read OpenMap's inventory: the API runs in-process on the compose stack,
// the estate of estate.ts in a tenant of its own, and a container of the image built from tools/inventory/check
// (INVENTORY_TOOLS_IMAGE) runs tools/inventory/check/run.sh against it through the shipped client scripts:
// - ansible-inventory --list over the script and over the plugin sees every host, hostvar and group the API answers,
//   and the plugin's keyed_groups build groups from openmap_attributes;
// - Salt's flat roster reads the roster file and the openmap roster module reads the API live, to the same targets;
// - puppet node find through the exec terminus classifies a certname with the ENC, and an unknown one with nothing;
// - knife loads the roles and nodes into chef-zero, shows a node with its run list, finds it by role and by the
//   openmap_site attribute, and the README's knife exec merge keeps a node's own run list.
// Without INVENTORY_TOOLS_IMAGE (no Docker on the runner) the file reports itself skipped; INVENTORY_TOOLS_OUT keeps the
// tools' output for the evidence.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type GenerateKeyPairResult } from 'jose';
import { loadEnv } from '@openmap/config';
import { createPrismaClient } from '@openmap/db';
import { OpenMapClient } from '@openmap/sdk';
import { AppModule } from '../app.module.js';
import { JWKS, realmUrl } from '../auth/jwks.provider.js';
import { SIGNING_ALGORITHM } from '../auth/auth.service.js';
import { ROLES } from '../auth/roles.js';
import { createEstate, dropEstate, ESTATE, type Estate } from './__tests__/estate.js';

process.env['IMPACT_VALIDATION_INTERVAL_MS'] = '0';
const image = process.env['INVENTORY_TOOLS_IMAGE'] ?? '';
const env = loadEnv();
const prisma = createPrismaClient(env);
const KID = 'openmap-inventory-tools-key';
const TIMEOUT_MS = 600_000;
const LISTEN_ALL = '0.0.0.0';
/** The name Docker Desktop and the host-gateway mapping give the host inside a container. */
const HOST_ALIAS = 'host.docker.internal';
const TOOLS_DIR = resolve(import.meta.dirname, '..', '..', '..', '..', 'tools', 'inventory');
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
/** The certname run.sh asks Puppet to classify that no CI has. */
const UNKNOWN_CERTNAME = 'unknown-node.openmap.invalid';
const UNSAFE_MARKER = '__ansible_unsafe';
const run = promisify(execFile);

let app: NestFastifyApplication;
let keys: GenerateKeyPairResult;
let estate: Estate | undefined;
let out = '';
let sdk: OpenMapClient;

function token(tenant: string): Promise<string> {
  return new SignJWT({
    tenant,
    preferred_username: 'inventory-tools',
    realm_access: { roles: [ROLES.analyst] },
    azp: env.KEYCLOAK_CLIENT_ID,
  })
    .setProtectedHeader({ alg: SIGNING_ALGORITHM, kid: KID })
    .setIssuer(realmUrl(env).toString())
    .setSubject('inventory-tools-' + randomUUID())
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(keys.privateKey);
}

function json<T>(file: string): T {
  return JSON.parse(readFileSync(join(out, file), 'utf8')) as T;
}

function text(file: string): string {
  return readFileSync(join(out, file), 'utf8');
}

interface AnsibleList {
  _meta: { hostvars: Record<string, Record<string, unknown>> };
  [group: string]:
    { hosts?: string[]; children?: string[] } | { hostvars: Record<string, Record<string, unknown>> };
}

/**
 * ansible-inventory --list writes a value an inventory plugin set as {__ansible_unsafe: value}: Ansible 2.19+ never trusts
 * inventory data as a template. The marker is Ansible's, not OpenMap's; the comparison reads through it.
 */
function trusted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(trusted);
  if (value === null || typeof value !== 'object') return value;
  const entries = Object.entries(value);
  const only = entries[0];
  if (entries.length === 1 && only !== undefined && only[0] === UNSAFE_MARKER) return trusted(only[1]);
  return Object.fromEntries(entries.map(([k, v]) => [k, trusted(v)]));
}

function hostsOf(list: AnsibleList, group: string): string[] {
  const g = list[group];
  return g !== undefined && 'hosts' in g ? [...(g.hosts ?? [])].sort() : [];
}

describe.runIf(image !== '')(
  'the real configuration-management tools over the inventory (integration)',
  () => {
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
      await app.listen(0, LISTEN_ALL);
      const port = new URL(await app.getUrl()).port;
      estate = await createEstate(prisma);
      const tenantId = estate.tenantId;
      sdk = new OpenMapClient({ baseUrl: await app.getUrl(), token: () => token(tenantId) });
      out = process.env['INVENTORY_TOOLS_OUT'] ?? mkdtempSync(join(tmpdir(), 'openmap-inventory-'));
      const args = [
        'run',
        '--rm',
        '--add-host',
        HOST_ALIAS + ':host-gateway',
        '--mount',
        'type=bind,source=' + TOOLS_DIR + ',target=/inv,readonly',
        '--mount',
        'type=bind,source=' + resolve(out) + ',target=/out',
        '-e',
        'OPENMAP_URL=http://' + HOST_ALIAS + ':' + port,
        '-e',
        'OPENMAP_TOKEN=' + (await token(tenantId)),
        '-e',
        'CERTNAME=' + ESTATE.app,
        '-e',
        'SITE_ROLE=openmap_site_' + ESTATE.site.toLowerCase(),
        '-e',
        'SITE_CODE=' + ESTATE.site,
        image,
        'sh',
        '/inv/check/run.sh',
      ];
      await run('docker', args, { maxBuffer: MAX_OUTPUT_BYTES });
    }, TIMEOUT_MS);

    afterAll(async () => {
      await dropEstate(prisma, estate);
      if (app !== undefined) await app.close();
      await prisma.$disconnect();
    }, TIMEOUT_MS);

    it('ansible-inventory reads every host, hostvar and group through the script and the plugin', async () => {
      const api = await sdk.inventory.ansible();
      const hosts = Object.keys(api._meta.hostvars).sort();
      for (const file of ['ansible-script.json', 'ansible-plugin.json']) {
        const list = trusted(json<AnsibleList>(file)) as AnsibleList;
        expect(Object.keys(list._meta.hostvars).sort()).toEqual(hosts);
        expect(list._meta.hostvars[ESTATE.app]).toMatchObject({
          ansible_host: ESTATE.appIp,
          openmap_site: ESTATE.site,
          openmap_attributes: { osName: 'RHEL' },
        });
        expect(hostsOf(list, 'service_bs_payments')).toEqual([ESTATE.esx, ESTATE.web].sort());
        expect(hostsOf(list, 'site_ryd')).toEqual([ESTATE.app, ESTATE.esx, ESTATE.web].sort());
        expect(hostsOf(list, 'site_jed')).toEqual([ESTATE.batch]);
        expect(hostsOf(list, 'tag_pci')).toEqual([ESTATE.app]);
      }
      const plugin = json<AnsibleList>('ansible-plugin.json');
      expect(hostsOf(plugin, 'os_RHEL')).toEqual([ESTATE.app]);
      expect(text('ansible-graph.txt')).toContain('@service_bs_payments:');
    });

    it('Salt reads the roster file and the roster module to the same targets', async () => {
      const api = await sdk.inventory.salt({ user: 'ops', sudo: 'true' });
      const targets = json<{
        flat: Record<string, Record<string, unknown>>;
        openmap: Record<string, Record<string, unknown>>;
      }>('salt-targets.json');
      expect(Object.keys(targets.flat).sort()).toEqual(Object.keys(api).sort());
      expect(targets.flat[ESTATE.app]).toMatchObject({ host: ESTATE.appIp, user: 'ops', sudo: true });
      expect(targets.flat[ESTATE.web]).toMatchObject({
        minion_opts: { grains: { openmap: { site: ESTATE.site } } },
      });
      expect(Object.keys(targets.openmap).sort()).toEqual(Object.keys(api).sort());
      expect(targets.openmap[ESTATE.switch]).toMatchObject({ host: ESTATE.switchIp });
      for (const host of Object.keys(api)) expect(text('salt-ssh-hosts.txt')).toContain(host);
    });

    it('Puppet classifies a certname with the ENC, and an unknown one with nothing', () => {
      const node = json<{
        name: string;
        classes: Record<string, unknown> | string[];
        parameters: Record<string, unknown>;
        environment: string;
      }>('puppet-node.json');
      expect(node.name).toBe(ESTATE.app);
      expect(Array.isArray(node.classes) ? node.classes : Object.keys(node.classes)).toEqual([
        'role::app',
        'profile::base',
      ]);
      expect(node.environment).toBe('staging');
      expect(node.parameters).toMatchObject({ openmap_site: ESTATE.site, openmap_id: estate?.ids.app });
      // Puppet leaves an empty class list out of the node it renders.
      const unknown = json<{ name: string; classes?: Record<string, unknown> | string[] }>(
        'puppet-unknown.json',
      );
      expect(unknown.name).toBe(UNKNOWN_CERTNAME);
      expect(Object.keys(unknown.classes ?? {})).toEqual([]);
    });

    it('knife loads the nodes and roles, shows a node with its run list and finds it by role', async () => {
      const api = await sdk.inventory.chef();
      expect([...json<string[]>('chef-nodes.json')].sort()).toEqual(api.nodes.map((n) => n.name).sort());
      const node = json<{
        name: string;
        chef_environment: string;
        run_list: string[];
        normal: { openmap: { site: string } };
      }>('chef-node.json');
      expect(node).toMatchObject({
        name: ESTATE.app,
        chef_environment: 'prod',
        run_list: ['role[openmap_site_ryd]'],
        normal: { openmap: { site: ESTATE.site } },
      });
      for (const file of ['chef-search.json', 'chef-search-site.json']) {
        expect([...json<{ rows: string[] }>(file).rows].sort()).toEqual(
          [ESTATE.app, ESTATE.esx, ESTATE.web].sort(),
        );
      }
      const merged = json<{ run_list: string[]; normal: { openmap: { id: string; site: string } } }>(
        'chef-merged.json',
      );
      expect(merged).toMatchObject({
        run_list: ['recipe[own::base]'],
        normal: { openmap: { id: estate?.ids.app, site: ESTATE.site } },
      });
    });
  },
);
