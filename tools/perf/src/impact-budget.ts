// REQ-PERF-002 — runs the impact-query k6 budget against a loaded estate, end to end:
// - picks the tenant with the most CIs (or --tenant);
// - picks root CIs: the PDUs feeding the most-connected network gear (the widest closures, the worst case) plus random PDUs,
//   database hosts and hypervisors;
// - creates or refreshes a load-test user for that tenant in Keycloak (analyst role, a fresh random password each run,
//   never stored) through the bootstrap administrator, and takes its token;
// - runs k6/impact-query.js with them; its summary writes results/impact-query.json, which `pnpm guard` checks
//   against PERF_BUDGETS.impactQuery100kP95Ms.
// Usage: pnpm --filter @openmap/perf impact-budget [--tenant <id>] [--roots id,id] [--vus N] [--duration 60s]
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '@openmap/config';
import { PERF_BUDGETS, ROLES } from '@openmap/constants';
import { createPrismaClient } from '@openmap/db';
import { createGraphRepository } from '@openmap/graph';

const PERF = {
  widestPdus: 2,
  candidatePdus: 100,
  randomPdus: 4,
  databaseHosts: 8,
  hypervisors: 6,
  userPrefix: 'perf-',
  tenantPrefix: 8,
  passwordBytes: 18,
} as const;

const env = loadEnv();
const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : undefined;
};

async function form(url: string, body: Record<string, string>): Promise<{ access_token: string }> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
  if (!res.ok) throw new Error(url + ' answered ' + String(res.status) + ': ' + (await res.text()));
  return (await res.json()) as { access_token: string };
}

/** A token for a load-test user of the tenant, created or refreshed through the Keycloak admin API. */
async function tokenFor(tenantId: string): Promise<string> {
  if (env.KEYCLOAK_ADMIN === '' || env.KEYCLOAK_ADMIN_PASSWORD === '') throw new Error('KEYCLOAK_ADMIN and KEYCLOAK_ADMIN_PASSWORD are required to create the load-test user');
  const base = env.KEYCLOAK_URL.replace(/\/+$/, '');
  const admin = (await form(base + '/realms/master/protocol/openid-connect/token', { grant_type: 'password', client_id: 'admin-cli', username: env.KEYCLOAK_ADMIN, password: env.KEYCLOAK_ADMIN_PASSWORD })).access_token;
  const headers = { authorization: 'Bearer ' + admin, 'content-type': 'application/json' };
  const api = base + '/admin/realms/' + env.KEYCLOAK_REALM;
  const username = PERF.userPrefix + tenantId.slice(0, PERF.tenantPrefix);
  const find = async (): Promise<{ id: string } | undefined> => ((await (await fetch(api + '/users?exact=true&username=' + username, { headers })).json()) as Array<{ id: string }>)[0];
  let user = await find();
  if (user === undefined) {
    const res = await fetch(api + '/users', { method: 'POST', headers, body: JSON.stringify({ username, enabled: true, emailVerified: true, email: username + '@perf.invalid', firstName: 'Load', lastName: 'Test', attributes: { tenant: [tenantId] }, requiredActions: [] }) });
    if (!res.ok) throw new Error('creating ' + username + ' answered ' + String(res.status));
    user = await find();
  }
  if (user === undefined) throw new Error('user ' + username + ' not found after creation');
  const password = randomBytes(PERF.passwordBytes).toString('base64url');
  await fetch(api + '/users/' + user.id + '/reset-password', { method: 'PUT', headers, body: JSON.stringify({ type: 'password', value: password, temporary: false }) });
  const roles = (await (await fetch(api + '/roles', { headers })).json()) as Array<{ id: string; name: string }>;
  const analyst = roles.find((r) => r.name === ROLES.analyst);
  if (analyst !== undefined) await fetch(api + '/users/' + user.id + '/role-mappings/realm', { method: 'POST', headers, body: JSON.stringify([analyst]) });
  return (await form(base + '/realms/' + env.KEYCLOAK_REALM + '/protocol/openid-connect/token', { grant_type: 'password', client_id: env.KEYCLOAK_CLIENT_ID, username, password, scope: 'openid' })).access_token;
}

async function main(): Promise<void> {
  const prisma = createPrismaClient(env);
  const tenantId =
    flag('tenant') ??
    (await prisma.ci.groupBy({ by: ['tenantId'], where: { validTo: null }, _count: { _all: true }, orderBy: { _count: { tenantId: 'desc' } }, take: 1 }))[0]?.tenantId;
  if (tenantId === undefined) throw new Error('no loaded estate: replay one first (tools/perf/README.md)');
  // The widest closures start at PDUs feeding network gear (31,355 nodes for one rack's PDUs on the scale estate), but no
  // attribute says which: a deterministic sample of them is measured through the graph and the widest are kept.
  const candidates = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM (
      SELECT DISTINCT p."toCiId" AS id FROM relationships p
      JOIN cis d ON d.id = p."fromCiId" AND d.type = 'network_device' AND d."validTo" IS NULL
      WHERE p."tenantId" = ${tenantId}::uuid AND p.type = 'powered_by' AND p."validTo" IS NULL
    ) pdus ORDER BY md5(id::text) LIMIT ${PERF.candidatePdus}`;
  const graph = createGraphRepository(env);
  const sized: Array<{ id: string; nodes: number }> = [];
  for (const c of candidates) {
    const r = await graph.impact(tenantId, c.id, { direction: 'upstream', maxDepth: 0, asOf: null, edgeTypes: [] });
    sized.push({ id: c.id, nodes: r.nodes.length });
  }
  await graph.close();
  const explicit = (flag('roots') ?? '').split(',').filter((x) => x !== '').map((id) => ({ id }));
  const widest = [...explicit, ...sized.sort((x, y) => y.nodes - x.nodes).slice(0, PERF.widestPdus)];
  console.log(JSON.stringify({ msg: 'widest sampled closures', nodes: sized.slice(0, PERF.widestPdus).map((x) => x.nodes) }));
  const sample = (type: string, take: number, name?: string) =>
    prisma.$queryRaw<Array<{ id: string }>>`SELECT id FROM cis WHERE "tenantId" = ${tenantId}::uuid AND type = ${type}::"CiType" AND "validTo" IS NULL AND (${name ?? null}::text IS NULL OR name ~ ${name ?? ''}) ORDER BY md5(id::text) LIMIT ${take}`;
  const roots = [...widest, ...(await sample('pdu', PERF.randomPdus)), ...(await sample('host', PERF.databaseHosts, 'db|sql|ora')), ...(await sample('hypervisor', PERF.hypervisors))].map((r) => r.id);
  await prisma.$disconnect();
  const token = await tokenFor(tenantId);
  console.log(JSON.stringify({ msg: 'impact budget', tenantId, roots: roots.length, budgetMs: PERF_BUDGETS.impactQuery100kP95Ms }));
  const cwd = fileURLToPath(new URL('..', import.meta.url));
  const k6 = spawnSync('k6', ['run', '--quiet', 'k6/impact-query.js'], {
    cwd,
    stdio: 'inherit',
    env: {
      ...process.env,
      API_URL: env.PUBLIC_API_URL.replace(/\/+$/, '') + '/graphql',
      TOKEN: token,
      ROOT_IDS: roots.join(','),
      BUDGET_MS: String(PERF_BUDGETS.impactQuery100kP95Ms),
      ...(flag('vus') === undefined ? {} : { VUS: flag('vus') }),
      ...(flag('duration') === undefined ? {} : { DURATION: flag('duration') }),
    },
  });
  process.exit(k6.status ?? 1);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
