// T-644 T-645 REQ-INT-016 (ADR-074) — identity federation end to end against the compose stack's Keycloak, Postgres
// and OpenBao. Two throwaway realms are created for the run (realm `openmap` and its users are never touched): a
// federation realm shaped like `openmap` (the OpenMap realm roles, the user profile and token mappers of
// deploy/compose/keycloak/realm-openmap.json), and a second realm standing in for an external OpenID Connect provider.
// A real OpenLDAP (bitnami openldap on network openmap_default) holds alice (in group `ops`) and bob (not in it).
// T-644: an administrator saves the directory through GraphQL (bind password as an OpenBao ref), tests it (Keycloak's
// bind test), syncs it; alice signs in with her directory password and her token carries openmap-operator and the
// tenant, bob's carries the tenant and no OpenMap role; remapping `ops` to admin changes alice's role at her next
// sign-in; a wrong bind password fails the test; removal takes the component, the groups and the sign-ins away.
// T-645: the second realm is registered as an OpenID Connect provider; Keycloak reads its discovery document (test and
// apply), the broker holds its endpoints, client and mappers, and carol (in the provider's group `om-ops`) signs in
// through the broker and gets openmap-operator and the tenant; a wrong issuer is kept as an error; removal deletes it.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { createLocalJWKSet, decodeJwt, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { TENANT_SETTINGS_DEFAULTS, loadEnv } from '@openmap/config';
import { ROLES } from '@openmap/constants';
import { createPrismaClient } from '@openmap/db';
import { AppModule } from '../app.module.js';
import { JWKS, realmUrl } from '../auth/jwks.provider.js';
import { SIGNING_ALGORITHM } from '../auth/auth.service.js';
import { SecretsService } from '../integrations/secrets.service.js';

const stamp = Date.now().toString(36) + randomUUID().slice(0, 4);
const FED_REALM = 'om-itest-fed-' + stamp;
const IDP_REALM = 'om-itest-idp-' + stamp;
process.env['IDENTITY_FEDERATION_REALM'] = FED_REALM;
process.env['IMPACT_VALIDATION_INTERVAL_MS'] = '0';
process.env['ANOMALY_INTERVAL_MS'] = '0';
const env = loadEnv();
const prisma = createPrismaClient(env);
const TIMEOUT_MS = 180_000;
const KID = 'openmap-identity-key';
const organizationId = randomUUID();
const tenantId = randomUUID();
const KC = env.KEYCLOAK_URL.replace(/\/$/u, '');
const PUBLIC_KC = env.PUBLIC_KEYCLOAK_URL.replace(/\/$/u, '');
const LDAP_IMAGE = 'bitnamilegacy/openldap:2.6';
const LDAP_NETWORK = 'openmap_default';
const LDAP_NAME = 'om-itest-ldap-' + stamp;
const LDAP_PORT = 1389;
const LDAP_BASE = 'dc=lab,dc=test';
const LDAP_ADMIN_DN = 'cn=admin,' + LDAP_BASE;
const ldapAdminPassword = randomUUID();
const alicePassword = randomUUID();
const bobPassword = randomUUID();
const carolPassword = randomUUID();
const brokerSecret = randomUUID();
const PROBE_CLIENT = 'itest-probe';
const PROBE_REDIRECT = 'http://localhost/itest-callback';
const BROKER_CLIENT = 'openmap-broker';
const SECRET_BASE = 'itest/identity/' + stamp;
const realmFile = fileURLToPath(new URL('../../../../deploy/compose/keycloak/realm-openmap.json', import.meta.url));

interface RealmFile {
  clients: Array<{ clientId: string; protocolMappers?: unknown[] }>;
  components: Record<string, Array<{ config: Record<string, string[]> }>>;
}
const openmapRealm = JSON.parse(readFileSync(realmFile, 'utf8')) as RealmFile;

let app: NestFastifyApplication;
let adminToken = '';
let operatorToken = '';
let kcToken = '';

const SOURCE_FIELDS =
  'id kind vendor name alias enabled secretRef state lastError roleMappings { group role } ldap { connectionUrl bindDn usersDn groupsDn usernameAttribute syncPeriodMinutes } oidc { issuer clientId scopes groupsClaim redirectUri } lastTest { ok message at } lastSync { added updated groups message at }';

interface SourceView {
  id: string;
  kind: string;
  vendor: string;
  alias: string;
  state: string;
  lastError: string | null;
  roleMappings: Array<{ group: string; role: string }>;
  ldap: { usernameAttribute: string; syncPeriodMinutes: number | null } | null;
  oidc: { issuer: string; scopes: string; groupsClaim: string; redirectUri: string } | null;
  lastTest: { ok: boolean; message: string } | null;
  lastSync: { added: number; groups: number } | null;
}

async function gql<T>(query: string, variables: Record<string, unknown> = {}, token = adminToken): Promise<{ data: T | null; error: string | null }> {
  const res = await app.inject({
    method: 'POST',
    url: '/graphql',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    payload: { query, variables },
  });
  const body = JSON.parse(res.body) as { data?: T | null; errors?: Array<{ message: string }> };
  return { data: body.data ?? null, error: body.errors?.[0]?.message ?? null };
}

async function upsert(id: string | null, input: Record<string, unknown>): Promise<SourceView> {
  const r = await gql<{ upsertIdentitySource: SourceView }>('mutation U($id: UUID, $input: IdentitySourceInput!) { upsertIdentitySource(id: $id, input: $input) { ' + SOURCE_FIELDS + ' } }', { id, input });
  if (r.data === null) throw new Error('upsertIdentitySource failed: ' + String(r.error));
  return r.data.upsertIdentitySource;
}

async function testSource(id: string): Promise<{ ok: boolean; message: string }> {
  const r = await gql<{ testIdentitySource: { ok: boolean; message: string } }>('mutation T($id: UUID!) { testIdentitySource(id: $id) { ok message at } }', { id });
  if (r.data === null) throw new Error('testIdentitySource failed: ' + String(r.error));
  return r.data.testIdentitySource;
}

async function adminLogin(): Promise<string> {
  const res = await fetch(KC + '/realms/master/protocol/openid-connect/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username: env.KEYCLOAK_ADMIN, password: env.KEYCLOAK_ADMIN_PASSWORD }),
  });
  return ((await res.json()) as { access_token: string }).access_token;
}

async function kc(method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  const res = await fetch(KC + '/admin/realms' + path, {
    method,
    headers: { authorization: 'Bearer ' + kcToken, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text === '' ? null : (JSON.parse(text) as unknown) };
}

async function passwordGrant(username: string, password: string): Promise<{ status: number; claims: Record<string, unknown> | null }> {
  const res = await fetch(KC + '/realms/' + FED_REALM + '/protocol/openid-connect/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'password', client_id: PROBE_CLIENT, username, password, scope: 'openid' }),
  });
  const body = (await res.json()) as { access_token?: string };
  return { status: res.status, claims: body.access_token === undefined ? null : decodeJwt(body.access_token) };
}

function roles(claims: Record<string, unknown> | null): string[] {
  const value = claims?.['roles'];
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** Retries a first call through Docker Desktop's port forwarding, which drops connections under bursts. */
async function retrying<T>(fn: () => Promise<T>, attempts = 5): Promise<T> {
  for (let i = 1; ; i += 1) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts) throw err;
      await new Promise((r) => setTimeout(r, 2000 * i));
    }
  }
}

function docker(args: string[], input?: string): string {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...(input === undefined ? {} : { input }) });
}

async function startLdap(): Promise<void> {
  docker(['run', '-d', '--rm', '--network', LDAP_NETWORK, '--name', LDAP_NAME, '-e', 'LDAP_ROOT=' + LDAP_BASE, '-e', 'LDAP_ADMIN_USERNAME=admin', '-e', 'LDAP_ADMIN_PASSWORD=' + ldapAdminPassword, '-e', 'LDAP_USERS=alice,bob', '-e', 'LDAP_PASSWORDS=' + alicePassword + ',' + bobPassword, '-e', 'LDAP_GROUP=staff', LDAP_IMAGE]);
  const deadline = Date.now() + TIMEOUT_MS / 2;
  for (;;) {
    try {
      docker(['exec', LDAP_NAME, 'ldapsearch', '-x', '-H', 'ldap://localhost:' + String(LDAP_PORT), '-D', LDAP_ADMIN_DN, '-w', ldapAdminPassword, '-b', 'ou=users,' + LDAP_BASE, 'uid=bob']);
      break;
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  const ldif = [
    'dn: cn=alice,ou=users,' + LDAP_BASE, 'changetype: modify', 'add: mail', 'mail: alice@lab.test', '',
    'dn: cn=bob,ou=users,' + LDAP_BASE, 'changetype: modify', 'add: mail', 'mail: bob@lab.test', '',
    'dn: cn=ops,ou=groups,' + LDAP_BASE, 'changetype: add', 'objectClass: groupOfNames', 'cn: ops', 'member: cn=alice,ou=users,' + LDAP_BASE, '',
  ].join('\n');
  docker(['exec', '-i', LDAP_NAME, 'ldapmodify', '-x', '-H', 'ldap://localhost:' + String(LDAP_PORT), '-D', LDAP_ADMIN_DN, '-w', ldapAdminPassword], ldif);
}

async function createRealms(): Promise<void> {
  const consoleMappers = openmapRealm.clients.find((c) => c.clientId === 'openmap-console')?.protocolMappers ?? [];
  const created = await kc('POST', '', {
    realm: FED_REALM,
    enabled: true,
    roles: { realm: [ROLES.admin, ROLES.operator, ROLES.analyst, ROLES.auditor].map((name) => ({ name })) },
    clients: [{ clientId: PROBE_CLIENT, publicClient: true, directAccessGrantsEnabled: true, standardFlowEnabled: true, redirectUris: [PROBE_REDIRECT], protocolMappers: consoleMappers }],
  });
  expect(created.status).toBe(201);
  const profile = openmapRealm.components['org.keycloak.userprofile.UserProfileProvider']?.[0]?.config['kc.user.profile.config']?.[0];
  expect(profile).toBeDefined();
  expect((await kc('PUT', '/' + FED_REALM + '/users/profile', JSON.parse(profile ?? '{}'))).status).toBe(200);
  const idp = await kc('POST', '', {
    realm: IDP_REALM,
    enabled: true,
    groups: [{ name: 'om-ops' }, { name: 'om-other' }],
    clients: [
      {
        clientId: BROKER_CLIENT,
        publicClient: false,
        secret: brokerSecret,
        standardFlowEnabled: true,
        redirectUris: [PUBLIC_KC + '/realms/' + FED_REALM + '/broker/*'],
        protocolMappers: [
          { name: 'groups', protocol: 'openid-connect', protocolMapper: 'oidc-group-membership-mapper', config: { 'claim.name': 'groups', 'full.path': 'false', 'id.token.claim': 'true', 'access.token.claim': 'true', 'userinfo.token.claim': 'true' } },
        ],
      },
    ],
    users: [{ username: 'carol', email: 'carol@idp.test', emailVerified: true, firstName: 'Carol', lastName: 'Broker', enabled: true, credentials: [{ type: 'password', value: carolPassword, temporary: false }], groups: ['/om-ops'] }],
  });
  expect(idp.status).toBe(201);
}

async function deleteSecret(ref: string): Promise<void> {
  await fetch(env.OPENBAO_ADDR.replace(/\/$/u, '') + '/v1/' + env.OPENBAO_MOUNT + '/metadata/' + ref, { method: 'DELETE', headers: { 'X-Vault-Token': env.OPENBAO_TOKEN ?? '' } }).catch(() => undefined);
}

/** A path-aware cookie jar and a browser's redirect-following, enough for Keycloak's login pages. */
class Browser {
  private readonly cookies = new Map<string, { name: string; value: string; path: string }>();

  private header(url: URL): string {
    return [...this.cookies.values()].filter((c) => url.pathname.startsWith(c.path)).map((c) => c.name + '=' + c.value).join('; ');
  }

  private store(res: Response): void {
    for (const line of res.headers.getSetCookie()) {
      const [pair = '', ...attributes] = line.split(';').map((p) => p.trim());
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      const path = attributes.find((a) => a.toLowerCase().startsWith('path='))?.slice('path='.length) ?? '/';
      if (value === '' || attributes.some((a) => a.toLowerCase() === 'max-age=0')) this.cookies.delete(name + '@' + path);
      else this.cookies.set(name + '@' + path, { name, value, path });
    }
  }

  async go(url: URL, init: { method?: string; form?: Record<string, string> } = {}): Promise<{ url: URL; status: number; html: string; location: string | null }> {
    const headers: Record<string, string> = { cookie: this.header(url) };
    if (init.form !== undefined) headers['content-type'] = 'application/x-www-form-urlencoded';
    const res = await fetch(url, { method: init.method ?? 'GET', headers, redirect: 'manual', ...(init.form === undefined ? {} : { body: new URLSearchParams(init.form).toString() }) });
    this.store(res);
    return { url, status: res.status, html: await res.text(), location: res.headers.get('location') };
  }
}

function decodeEntities(s: string): string {
  return s.replace(/&amp;/gu, '&').replace(/&#x2F;/giu, '/').replace(/&#47;/gu, '/').replace(/&quot;/gu, '"');
}

/** Follows redirects and submits Keycloak's forms (the provider's login, a profile review) until the client callback. */
async function brokeredSignIn(alias: string, username: string, password: string): Promise<Record<string, unknown>> {
  const browser = new Browser();
  const start = new URL(KC + '/realms/' + FED_REALM + '/protocol/openid-connect/auth');
  start.search = new URLSearchParams({ client_id: PROBE_CLIENT, redirect_uri: PROBE_REDIRECT, response_type: 'code', scope: 'openid', state: stamp, nonce: stamp, kc_idp_hint: alias }).toString();
  let page = await browser.go(start);
  for (let step = 0; step < 20; step += 1) {
    if (page.location !== null) {
      const next = new URL(page.location, page.url);
      if (next.toString().startsWith(PROBE_REDIRECT)) {
        const code = next.searchParams.get('code');
        if (code === null) throw new Error('callback without a code: ' + next.toString());
        const res = await fetch(KC + '/realms/' + FED_REALM + '/protocol/openid-connect/token', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ grant_type: 'authorization_code', client_id: PROBE_CLIENT, code, redirect_uri: PROBE_REDIRECT }),
        });
        const body = (await res.json()) as { access_token?: string; error_description?: string };
        if (body.access_token === undefined) throw new Error('code exchange failed: ' + String(body.error_description));
        return decodeJwt(body.access_token);
      }
      // Keycloak's public origin (KC_HOSTNAME) and its backchannel address are the same host on the dev stack.
      page = await browser.go(new URL(next.pathname + next.search, KC));
      continue;
    }
    const form = /<form[^>]*action="([^"]+)"[^>]*>([\s\S]*?)<\/form>/u.exec(page.html);
    if (form === null) throw new Error('page without a form (HTTP ' + String(page.status) + '): ' + page.html.slice(0, 400));
    const fields: Record<string, string> = {};
    for (const input of (form[2] ?? '').matchAll(/<input[^>]*name="([^"]+)"[^>]*?(?:value="([^"]*)")?[^>]*>/gu)) fields[input[1] ?? ''] = decodeEntities(input[2] ?? '');
    if ('password' in fields) Object.assign(fields, { username, password });
    const action = new URL(decodeEntities(form[1] ?? ''), page.url);
    page = await browser.go(new URL(action.pathname + action.search, KC), { method: 'POST', form: fields });
  }
  throw new Error('brokered sign-in did not reach the client');
}

describe('identity federation (integration)', () => {
  beforeAll(async () => {
    const keys = await generateKeyPair(SIGNING_ALGORITHM);
    const jwk = { ...(await exportJWK(keys.publicKey)), kid: KID, alg: SIGNING_ALGORITHM, use: 'sig' };
    const sign = (role: string, username: string): Promise<string> =>
      new SignJWT({ tenant: tenantId, preferred_username: username, realm_access: { roles: [role] }, azp: env.KEYCLOAK_CLIENT_ID })
        .setProtectedHeader({ alg: SIGNING_ALGORITHM, kid: KID })
        .setIssuer(realmUrl(env).toString())
        .setSubject(username + '-' + stamp)
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(keys.privateKey);
    adminToken = await sign(ROLES.admin, 'identity-admin');
    operatorToken = await sign(ROLES.operator, 'identity-operator');
    // The fixtures come first and the application last: its start opens a burst of store connections, and Docker
    // Desktop's port forwarding drops new connections made during such a burst.
    await retrying(() => prisma.organization.create({ data: { id: organizationId, name: 'Identity org', industry: 'test', timeZone: 'UTC', defaultLocale: 'en', regulatoryScope: [], airGapped: false } }));
    await prisma.tenant.create({ data: { id: tenantId, organizationId, name: 'Identity BU', slug: 'idf-' + tenantId.slice(0, 8) } });
    await prisma.tenantSettings.create({ data: { tenantId, ...TENANT_SETTINGS_DEFAULTS } });
    const secrets = new SecretsService(env);
    await retrying(() => secrets.write(SECRET_BASE + '/ldap', { password: ldapAdminPassword }));
    await retrying(() => secrets.write(SECRET_BASE + '/ldap-wrong', { password: 'not-' + ldapAdminPassword }));
    await retrying(() => secrets.write(SECRET_BASE + '/oidc', { clientSecret: brokerSecret }));
    kcToken = await retrying(adminLogin);
    await createRealms();
    await startLdap();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(JWKS).useValue(createLocalJWKSet({ keys: [jwk] })).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), { logger: ['error', 'warn'] });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  }, TIMEOUT_MS);

  afterAll(async () => {
    kcToken = await adminLogin().catch(() => kcToken);
    await kc('DELETE', '/' + FED_REALM).catch(() => undefined);
    await kc('DELETE', '/' + IDP_REALM).catch(() => undefined);
    try {
      docker(['stop', LDAP_NAME]);
    } catch {
      // The container was never started, or is already gone (--rm).
    }
    for (const ref of ['ldap', 'ldap-wrong', 'oidc']) await deleteSecret(SECRET_BASE + '/' + ref);
    await prisma.outboxEvent.deleteMany({ where: { tenantId } });
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    if (app !== undefined) await app.close();
    await prisma.$disconnect();
  }, TIMEOUT_MS);

  it('T-644 federates a directory: bind test, sync, group-mapped roles at sign-in, remap, removal', async () => {
    const ldap = { connectionUrl: 'ldap://' + LDAP_NAME + ':' + String(LDAP_PORT), bindDn: LDAP_ADMIN_DN, usersDn: 'ou=users,' + LDAP_BASE, groupsDn: 'ou=groups,' + LDAP_BASE, syncPeriodMinutes: 60 };
    const input = { vendor: 'ldap', name: 'Lab directory', secretRef: SECRET_BASE + '/ldap', roleMappings: [{ group: 'ops', role: 'operator' }], ldap };
    expect((await gql('{ identitySources { id } }', {}, operatorToken)).error).toMatch(/forbidden|role/iu);

    const saved = await upsert(null, input);
    expect(saved).toMatchObject({ kind: 'ldap', vendor: 'ldap', state: 'applied', lastError: null, roleMappings: [{ group: 'ops', role: 'operator' }] });
    expect(saved.ldap).toMatchObject({ usernameAttribute: 'uid', syncPeriodMinutes: 60 });
    expect(saved.alias).toMatch(/^openmap-lab-directory-[0-9a-f]{8}$/u);

    const tested = await testSource(saved.id);
    expect(tested.ok).toBe(true);
    expect(tested.message).toContain('bound as ' + LDAP_ADMIN_DN);

    const synced = await gql<{ syncIdentitySource: { added: number; updated: number; groups: number; message: string } }>('mutation S($id: UUID!) { syncIdentitySource(id: $id) { added updated removed failed groups message at } }', { id: saved.id });
    expect(synced.error).toBeNull();
    expect((synced.data?.syncIdentitySource.added ?? 0) + (synced.data?.syncIdentitySource.updated ?? 0)).toBe(2);
    expect(synced.data?.syncIdentitySource.groups).toBe(2);

    const row = await prisma.identitySource.findUniqueOrThrow({ where: { id: saved.id } });
    const component = await kc('GET', '/' + FED_REALM + '/components/' + String(row.keycloakId));
    expect(component.body).toMatchObject({ name: saved.alias, providerId: 'ldap', config: { vendor: ['other'], editMode: ['READ_ONLY'], fullSyncPeriod: ['3600'], bindCredential: ['**********'] } });
    const groups = (await kc('GET', '/' + FED_REALM + '/groups?exact=true&search=' + saved.alias)).body as Array<{ id: string; name: string }>;
    const parent = groups.find((g) => g.name === saved.alias);
    expect(parent).toBeDefined();
    const children = (await kc('GET', '/' + FED_REALM + '/groups/' + String(parent?.id) + '/children')).body as Array<{ id: string; name: string }>;
    expect(children.map((c) => c.name).sort()).toEqual(['ops', 'staff']);

    const alice = await passwordGrant('alice', alicePassword);
    expect(alice.status).toBe(200);
    expect(alice.claims?.['tenant']).toBe(tenantId);
    expect(roles(alice.claims)).toContain(ROLES.operator);
    expect(roles(alice.claims)).not.toContain(ROLES.admin);
    const bob = await passwordGrant('bob', bobPassword);
    expect(bob.status).toBe(200);
    expect(bob.claims?.['tenant']).toBe(tenantId);
    expect(roles(bob.claims).filter((r) => r.startsWith('openmap-'))).toEqual([]);
    expect((await passwordGrant('alice', 'wrong-' + alicePassword)).status).toBe(401);

    const remapped = await upsert(saved.id, { ...input, roleMappings: [{ group: 'ops', role: 'admin' }] });
    expect(remapped.state).toBe('applied');
    expect(remapped.alias).toBe(saved.alias);
    const aliceAgain = await passwordGrant('alice', alicePassword);
    expect(roles(aliceAgain.claims)).toContain(ROLES.admin);
    expect(roles(aliceAgain.claims)).not.toContain(ROLES.operator);

    const wrong = await upsert(saved.id, { ...input, secretRef: SECRET_BASE + '/ldap-wrong', roleMappings: [{ group: 'ops', role: 'admin' }] });
    expect(wrong.state).toBe('applied');
    const failed = await testSource(saved.id);
    expect(failed.ok).toBe(false);
    expect(failed.message).toMatch(/AuthenticationFailure|bind/iu);
    const listed = await gql<{ identitySources: SourceView[] }>('{ identitySources { ' + SOURCE_FIELDS + ' } }');
    expect(listed.data?.identitySources.find((s) => s.id === saved.id)?.lastTest?.ok).toBe(false);
    expect(listed.data?.identitySources.find((s) => s.id === saved.id)?.lastSync?.groups).toBe(2);

    const removed = await gql<{ removeIdentitySource: boolean }>('mutation R($id: UUID!) { removeIdentitySource(id: $id) }', { id: saved.id });
    expect(removed.data?.removeIdentitySource).toBe(true);
    expect((await kc('GET', '/' + FED_REALM + '/components/' + String(row.keycloakId))).status).toBe(404);
    const after = (await kc('GET', '/' + FED_REALM + '/groups?exact=true&search=' + saved.alias)).body as Array<{ name: string }>;
    expect(after.some((g) => g.name === saved.alias)).toBe(false);
    expect((await passwordGrant('alice', alicePassword)).status).toBe(401);
    expect(await prisma.identitySource.count({ where: { id: saved.id } })).toBe(0);
    const audit = await prisma.outboxEvent.findMany({ where: { tenantId, subject: saved.id, type: 'openmap.audit.action' }, orderBy: { sequence: 'asc' } });
    expect(audit.map((e) => (e.envelope as { data: { action: string } }).data.action)).toEqual([
      'identity_source.created',
      'identity_source.synced',
      'identity_source.updated',
      'identity_source.updated',
      'identity_source.removed',
    ]);
  }, TIMEOUT_MS);

  it('T-645 brokers an OpenID Connect provider: discovery, broker config and mappers, a brokered sign-in, removal', async () => {
    const issuer = PUBLIC_KC + '/realms/' + IDP_REALM;
    const input = { vendor: 'oidc', name: 'Partner IdP', secretRef: SECRET_BASE + '/oidc', roleMappings: [{ group: 'om-ops', role: 'operator' }], oidc: { issuer, clientId: BROKER_CLIENT } };
    const saved = await upsert(null, input);
    expect(saved).toMatchObject({ kind: 'oidc', state: 'applied', lastError: null });
    expect(saved.oidc).toMatchObject({ issuer, scopes: 'openid profile email', groupsClaim: 'groups', redirectUri: PUBLIC_KC + '/realms/' + FED_REALM + '/broker/' + saved.alias + '/endpoint' });

    const tested = await testSource(saved.id);
    expect(tested.ok).toBe(true);
    expect(tested.message).toContain(issuer);

    const discovery = (await (await fetch(KC + '/realms/' + IDP_REALM + '/.well-known/openid-configuration')).json()) as Record<string, string>;
    const broker = await kc('GET', '/' + FED_REALM + '/identity-provider/instances/' + saved.alias);
    expect(broker.body).toMatchObject({
      alias: saved.alias,
      providerId: 'oidc',
      enabled: true,
      displayName: 'Partner IdP',
      config: {
        issuer: discovery['issuer'],
        authorizationUrl: discovery['authorization_endpoint'],
        tokenUrl: discovery['token_endpoint'],
        jwksUrl: discovery['jwks_uri'],
        clientId: BROKER_CLIENT,
        clientAuthMethod: 'client_secret_post',
        pkceEnabled: 'true',
        syncMode: 'FORCE',
      },
    });
    expect((broker.body as { config: Record<string, string> }).config['clientSecret']).not.toBe(brokerSecret);
    const mappers = (await kc('GET', '/' + FED_REALM + '/identity-provider/instances/' + saved.alias + '/mappers')).body as Array<{ name: string; identityProviderMapper: string; config: Record<string, string> }>;
    expect(mappers.find((m) => m.name === 'openmap-tenant')?.config).toMatchObject({ attribute: 'tenant', 'attribute.value': tenantId });
    expect(mappers.find((m) => m.identityProviderMapper === 'oidc-role-idp-mapper')?.config).toMatchObject({ claim: 'groups', 'claim.value': 'om-ops', role: ROLES.operator });

    const carol = await brokeredSignIn(saved.alias, 'carol', carolPassword);
    expect(carol['preferred_username']).toBe('carol');
    expect(carol['tenant']).toBe(tenantId);
    expect(roles(carol)).toContain(ROLES.operator);

    const broken = await upsert(saved.id, { ...input, oidc: { issuer: PUBLIC_KC + '/realms/' + IDP_REALM + '-missing', clientId: BROKER_CLIENT } });
    expect(broken.state).toBe('error');
    expect(broken.lastError).toMatch(/could not read/u);
    expect((await testSource(saved.id)).ok).toBe(false);

    const removed = await gql<{ removeIdentitySource: boolean }>('mutation R($id: UUID!) { removeIdentitySource(id: $id) }', { id: saved.id });
    expect(removed.data?.removeIdentitySource).toBe(true);
    expect((await kc('GET', '/' + FED_REALM + '/identity-provider/instances/' + saved.alias)).status).toBe(404);

    // Both runs above are counted on the API's Prometheus registry (the spans identity.source.* wrap the same calls).
    const metrics = (await app.inject({ method: 'GET', url: env.METRICS_PATH })).body;
    for (const series of [
      'openmap_identity_source_operations_total{op="apply",kind="ldap",outcome="ok"}',
      'openmap_identity_source_operations_total{op="test",kind="ldap",outcome="error"}',
      'openmap_identity_source_operations_total{op="sync",kind="ldap",outcome="ok"}',
      'openmap_identity_source_operations_total{op="apply",kind="oidc",outcome="error"}',
      'openmap_identity_source_operations_total{op="remove",kind="oidc",outcome="ok"}',
    ])
      expect(metrics).toContain(series);
    expect(metrics).toMatch(/openmap_identity_sync_users_total\{result="added"\} [1-9]/u);
  }, TIMEOUT_MS);
});
