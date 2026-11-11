// REQ-PERF-002 REQ-UI-027 — a load-test user per tenant for the k6 budgets: created or refreshed in Keycloak through the
// bootstrap administrator (analyst role, a fresh random password each run, never stored), and its access token.
import { randomBytes } from 'node:crypto';
import type { Env } from '@openmap/config';
import { ROLES } from '@openmap/constants';

const USER = {
  prefix: 'perf-',
  tenantPrefix: 8,
  passwordBytes: 18,
} as const;

// The realm's console client takes no password grant (browser sign-in only), so the load-test user signs in through a
// public client of its own, created on first use with the console client's mappers (the tenant claim) and an audience
// mapper for the API's client, which the API accepts.
const PERF_CLIENT_ID = 'openmap-perf';

interface ClientRepresentation {
  protocolMappers?: Array<Record<string, unknown> & { id?: string }>;
  defaultClientScopes?: string[];
  optionalClientScopes?: string[];
}

async function ensurePerfClient(env: Env, api: string, headers: Record<string, string>): Promise<void> {
  const existing = (await (await fetch(api + '/clients?clientId=' + PERF_CLIENT_ID, { headers })).json()) as unknown[];
  if (existing.length > 0) return;
  const [source] = (await (await fetch(api + '/clients?clientId=' + encodeURIComponent(env.KEYCLOAK_CLIENT_ID), { headers })).json()) as ClientRepresentation[];
  const mappers = (source?.protocolMappers ?? []).map(({ id: _id, ...m }) => m);
  mappers.push({
    name: 'api audience',
    protocol: 'openid-connect',
    protocolMapper: 'oidc-audience-mapper',
    config: { 'included.client.audience': env.KEYCLOAK_API_CLIENT_ID, 'access.token.claim': 'true', 'id.token.claim': 'false' },
  });
  const res = await fetch(api + '/clients', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      clientId: PERF_CLIENT_ID,
      name: 'OpenMap load tests',
      publicClient: true,
      standardFlowEnabled: false,
      directAccessGrantsEnabled: true,
      protocolMappers: mappers,
      defaultClientScopes: source?.defaultClientScopes ?? [],
      optionalClientScopes: source?.optionalClientScopes ?? [],
    }),
  });
  if (!res.ok) throw new Error('creating client ' + PERF_CLIENT_ID + ' answered ' + String(res.status) + ': ' + (await res.text()));
}

async function form(url: string, body: Record<string, string>): Promise<{ access_token: string }> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
  if (!res.ok) throw new Error(url + ' answered ' + String(res.status) + ': ' + (await res.text()));
  return (await res.json()) as { access_token: string };
}

/** A token for a load-test user of the tenant, created or refreshed through the Keycloak admin API. */
export async function tokenFor(env: Env, tenantId: string): Promise<string> {
  if (env.KEYCLOAK_ADMIN === '' || env.KEYCLOAK_ADMIN_PASSWORD === '') throw new Error('KEYCLOAK_ADMIN and KEYCLOAK_ADMIN_PASSWORD are required to create the load-test user');
  const base = env.KEYCLOAK_URL.replace(/\/+$/, '');
  const admin = (await form(base + '/realms/master/protocol/openid-connect/token', { grant_type: 'password', client_id: 'admin-cli', username: env.KEYCLOAK_ADMIN, password: env.KEYCLOAK_ADMIN_PASSWORD })).access_token;
  const headers = { authorization: 'Bearer ' + admin, 'content-type': 'application/json' };
  const api = base + '/admin/realms/' + env.KEYCLOAK_REALM;
  const username = USER.prefix + tenantId.slice(0, USER.tenantPrefix);
  const find = async (): Promise<{ id: string } | undefined> => ((await (await fetch(api + '/users?exact=true&username=' + username, { headers })).json()) as Array<{ id: string }>)[0];
  let user = await find();
  if (user === undefined) {
    const res = await fetch(api + '/users', { method: 'POST', headers, body: JSON.stringify({ username, enabled: true, emailVerified: true, email: username + '@perf.invalid', firstName: 'Load', lastName: 'Test', attributes: { tenant: [tenantId] }, requiredActions: [] }) });
    if (!res.ok) throw new Error('creating ' + username + ' answered ' + String(res.status));
    user = await find();
  }
  if (user === undefined) throw new Error('user ' + username + ' not found after creation');
  const password = randomBytes(USER.passwordBytes).toString('base64url');
  await fetch(api + '/users/' + user.id + '/reset-password', { method: 'PUT', headers, body: JSON.stringify({ type: 'password', value: password, temporary: false }) });
  const roles = (await (await fetch(api + '/roles', { headers })).json()) as Array<{ id: string; name: string }>;
  const analyst = roles.find((r) => r.name === ROLES.analyst);
  if (analyst !== undefined) await fetch(api + '/users/' + user.id + '/role-mappings/realm', { method: 'POST', headers, body: JSON.stringify([analyst]) });
  await ensurePerfClient(env, api, headers);
  return (await form(base + '/realms/' + env.KEYCLOAK_REALM + '/protocol/openid-connect/token', { grant_type: 'password', client_id: PERF_CLIENT_ID, username, password, scope: 'openid' })).access_token;
}
