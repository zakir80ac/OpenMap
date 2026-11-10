// T-642 REQ-INT-016 (ADR-074) — the Keycloak admin client: the password grant of KEYCLOAK_ADMIN, or the
// client-credentials grant when an admin client secret is configured, in KEYCLOAK_ADMIN_REALM; one token reused until
// shortly before it expires; a refused token dropped and the call sent once more; calls addressed to the federation
// realm; Keycloak's reason carried into errors; no credentials, no call.
import { describe, expect, it } from 'vitest';
import { loadEnv } from '@openmap/config';
import { KeycloakAdminClient, KeycloakError, createdId, federationRealm, keycloakReason } from './keycloak-admin.client.js';

interface Seen {
  url: string;
  method: string;
  body: string;
  authorization: string;
}

function harness(overrides: Record<string, string>, answers: Array<(seen: Seen) => Response>): { client: KeycloakAdminClient; seen: Seen[] } {
  const env = loadEnv(overrides);
  const client = new KeycloakAdminClient(env);
  const seen: Seen[] = [];
  client.fetchImpl = (input, init) => {
    const headers = new Headers(init?.headers);
    const s = { url: String(input), method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? init.body : '', authorization: headers.get('authorization') ?? '' };
    seen.push(s);
    const answer = answers.shift();
    if (answer === undefined) throw new Error('unexpected call ' + s.method + ' ' + s.url);
    return Promise.resolve(answer(s));
  };
  return { client, seen };
}

const token = (value: string, expiresIn = 300): Response => Response.json({ access_token: value, expires_in: expiresIn });

describe('Keycloak admin client', () => {
  it('signs in with the administrator password grant and reuses the token', async () => {
    const { client, seen } = harness({ KEYCLOAK_ADMIN: 'admin', KEYCLOAK_ADMIN_PASSWORD: 'pw', KEYCLOAK_REALM: 'openmap' }, [
      () => token('t1'),
      () => Response.json({ id: 'realm-id' }),
      () => new Response(null, { status: 201, headers: { location: 'http://kc/admin/realms/openmap/components/abc' } }),
    ]);
    expect((await client.call('GET', '')).body).toEqual({ id: 'realm-id' });
    const created = await client.call('POST', '/components', { name: 'x' });
    expect(createdId(created)).toBe('abc');
    expect(seen[0]?.url).toMatch(/\/realms\/master\/protocol\/openid-connect\/token$/u);
    expect(new URLSearchParams(seen[0]?.body)).toEqual(new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username: 'admin', password: 'pw' }));
    expect(seen[1]?.url).toMatch(/\/admin\/realms\/openmap$/u);
    expect(seen[2]?.authorization).toBe('Bearer t1');
    expect(seen).toHaveLength(3);
  });

  it('prefers the client-credentials grant and targets the federation realm', async () => {
    const { client, seen } = harness({ KEYCLOAK_ADMIN_CLIENT_ID: 'openmap-admin-api', KEYCLOAK_ADMIN_CLIENT_SECRET: 'cs', KEYCLOAK_ADMIN_REALM: 'openmap', IDENTITY_FEDERATION_REALM: 'staff' }, [
      () => token('t1'),
      () => new Response(null, { status: 204 }),
    ]);
    expect(client.realm).toBe('staff');
    expect((await client.call('DELETE', '/components/x')).status).toBe(204);
    expect(seen[0]?.url).toMatch(/\/realms\/openmap\/protocol\/openid-connect\/token$/u);
    expect(new URLSearchParams(seen[0]?.body).get('grant_type')).toBe('client_credentials');
    expect(new URLSearchParams(seen[0]?.body).get('client_secret')).toBe('cs');
    expect(seen[1]?.url).toMatch(/\/admin\/realms\/staff\/components\/x$/u);
  });

  it('drops a refused token and sends the call once more', async () => {
    const { client, seen } = harness({ KEYCLOAK_ADMIN: 'admin', KEYCLOAK_ADMIN_PASSWORD: 'pw' }, [
      () => token('stale'),
      () => new Response(null, { status: 401 }),
      () => token('fresh'),
      () => Response.json([]),
    ]);
    expect((await client.call('GET', '/groups')).body).toEqual([]);
    expect(seen.map((s) => s.authorization)).toEqual(['', 'Bearer stale', '', 'Bearer fresh']);
  });

  it('carries Keycloak’s reason, and refuses to call without credentials', async () => {
    const { client } = harness({ KEYCLOAK_ADMIN: 'admin', KEYCLOAK_ADMIN_PASSWORD: 'pw' }, [() => token('t'), () => Response.json({ errorMessage: 'AuthenticationFailure' }, { status: 400 })]);
    await expect(client.call('POST', '/testLDAPConnection', {})).rejects.toThrow(/HTTP 400: AuthenticationFailure/u);
    expect(keycloakReason(409, { errorMessage: 'Identity Provider exists' })).toBe('Keycloak answered HTTP 409: Identity Provider exists');
    expect(keycloakReason(500, 'oops')).toBe('Keycloak answered HTTP 500');
    expect(() => createdId({ status: 201, ok: true, location: null, body: null })).toThrow(KeycloakError);
    const bare = harness({ KEYCLOAK_ADMIN: '', KEYCLOAK_ADMIN_PASSWORD: '', KEYCLOAK_ADMIN_CLIENT_SECRET: '' }, []);
    expect(bare.client.configured()).toBe(false);
    await expect(bare.client.call('GET', '')).rejects.toThrow(/not configured/u);
    expect(federationRealm({ IDENTITY_FEDERATION_REALM: '', KEYCLOAK_REALM: 'openmap' })).toBe('openmap');
  });
});
