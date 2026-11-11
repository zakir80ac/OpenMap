// REQ-QA-004 — points the realm's seeded users at the tenant a replayed synthetic estate created (its slug is
// `synth-<first id segment>`), so the e2e suite signs in to the estate it reads; the realm import gives them the
// `default` tenant. Used by the CI e2e job after it replays the estate; on a dev stack it is a one-off.
//   pnpm --filter @openmap/perf e2e-users --tenant <slug>
import { loadEnv } from '@openmap/config';

async function main(): Promise<void> {
  const env = loadEnv();
  const at = process.argv.indexOf('--tenant');
  const tenant = at >= 0 ? process.argv[at + 1] : undefined;
  if (tenant === undefined || tenant === '') throw new Error('usage: e2e-users --tenant <slug>');
  if (env.KEYCLOAK_ADMIN === '' || env.KEYCLOAK_ADMIN_PASSWORD === '') throw new Error('KEYCLOAK_ADMIN and KEYCLOAK_ADMIN_PASSWORD are required');
  const base = env.KEYCLOAK_URL.replace(/\/+$/, '');
  const login = await fetch(base + '/realms/master/protocol/openid-connect/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username: env.KEYCLOAK_ADMIN, password: env.KEYCLOAK_ADMIN_PASSWORD }),
  });
  if (!login.ok) throw new Error('admin sign-in answered ' + String(login.status));
  const headers = { authorization: 'Bearer ' + ((await login.json()) as { access_token: string }).access_token, 'content-type': 'application/json' };
  const api = base + '/admin/realms/' + env.KEYCLOAK_REALM;
  const users = (await (await fetch(api + '/users?q=tenant:default&max=1000', { headers })).json()) as Array<{ id: string; username: string; attributes?: Record<string, string[]> }>;
  let moved = 0;
  for (const user of users) {
    if (user.attributes?.['tenant']?.[0] !== 'default') continue;
    const full = (await (await fetch(api + '/users/' + user.id, { headers })).json()) as Record<string, unknown> & { attributes?: Record<string, string[]> };
    const res = await fetch(api + '/users/' + user.id, { method: 'PUT', headers, body: JSON.stringify({ ...full, attributes: { ...full.attributes, tenant: [tenant] } }) });
    if (!res.ok) throw new Error('updating ' + user.username + ' answered ' + String(res.status));
    moved += 1;
  }
  console.log(JSON.stringify({ msg: 'e2e users pointed at the estate', tenant, users: moved }));
}

await main();
