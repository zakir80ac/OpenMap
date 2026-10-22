// T-080 REQ-SEC-001 — shared fixtures for the auth tests: an unsigned compact JWT builder (the console never verifies
// signatures, so a fixed signature segment is enough), a fetch stub that plays the identity provider (discovery
// document and token endpoint), and the environment the console reads its OIDC settings from.
import { vi } from 'vitest';
import { base64UrlEncode } from '../pkce';

export const IDP_ORIGIN = 'http://idp.test';
export const REALM = 'openmap';
export const CLIENT_ID = 'openmap-console';
export const ISSUER = IDP_ORIGIN + '/realms/' + REALM;
export const DISCOVERY_URL = ISSUER + '/.well-known/openid-configuration';
export const AUTHORIZE_URL = ISSUER + '/protocol/openid-connect/auth';
export const TOKEN_URL = ISSUER + '/protocol/openid-connect/token';
export const END_SESSION_URL = ISSUER + '/protocol/openid-connect/logout';

export const discoveryDocument = {
  issuer: ISSUER,
  authorization_endpoint: AUTHORIZE_URL,
  token_endpoint: TOKEN_URL,
  end_session_endpoint: END_SESSION_URL,
  jwks_uri: ISSUER + '/protocol/openid-connect/certs',
};

export function installAuthEnv(): void {
  process.env['NEXT_PUBLIC_KEYCLOAK_URL'] = IDP_ORIGIN;
  process.env['NEXT_PUBLIC_KEYCLOAK_REALM'] = REALM;
  process.env['NEXT_PUBLIC_KEYCLOAK_CLIENT_ID'] = CLIENT_ID;
  process.env['NEXT_PUBLIC_API_URL'] = 'http://api.test';
}

export function makeJwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown): string => base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));
  return encode({ alg: 'RS256', typ: 'JWT', kid: 'test-key' }) + '.' + encode(payload) + '.' + base64UrlEncode(new Uint8Array([1, 2, 3]));
}

export interface UserClaims {
  sub?: string;
  preferred_username?: string;
  name?: string;
  email?: string;
  tenant?: string;
  roles?: string[];
  nonce?: string;
}

export const defaultUser: UserClaims = {
  sub: 'b4b2f1a0-0000-4000-8000-000000000001',
  preferred_username: 'admin',
  name: 'OpenMap Admin',
  email: 'admin@openmap.local',
  tenant: 'default',
  roles: ['openmap-admin', 'offline_access'],
};

export function tokenResponse(user: UserClaims = defaultUser, expiresIn = 900, suffix = ''): Record<string, unknown> {
  const base = { iss: ISSUER, azp: CLIENT_ID, ...user };
  return {
    access_token: makeJwt({ ...base, typ: 'Bearer', realm_access: { roles: user.roles ?? [] }, marker: 'access' + suffix }),
    refresh_token: 'refresh-' + (suffix === '' ? 'initial' : suffix),
    id_token: makeJwt({ ...base, typ: 'ID', marker: 'id' + suffix }),
    token_type: 'Bearer',
    expires_in: expiresIn,
    scope: 'openid profile email',
  };
}

export interface IdpCall {
  url: string;
  method: string;
  body: URLSearchParams | undefined;
  headers: Record<string, string>;
}

export interface IdpStub {
  calls: IdpCall[];
  /** Replace what the token endpoint answers; the default issues a fresh token set per grant. */
  tokenHandler: (body: URLSearchParams, call: number) => Response;
  fetch: typeof fetch;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Stand-in for Keycloak over fetch: serves the discovery document and answers token grants. */
export function createIdpStub(): IdpStub {
  const calls: IdpCall[] = [];
  const stub: IdpStub = {
    calls,
    tokenHandler: (_body, call) => json(tokenResponse(defaultUser, 900, call === 0 ? '' : String(call))),
    fetch: vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? 'GET';
      const headers = Object.fromEntries(Object.entries((init?.headers as Record<string, string> | undefined) ?? {}));
      const body = typeof init?.body === 'string' ? new URLSearchParams(init.body) : undefined;
      calls.push({ url, method, body, headers });
      if (url === DISCOVERY_URL) return Promise.resolve(json(discoveryDocument));
      if (url === TOKEN_URL && body !== undefined) {
        const tokenCalls = calls.filter((c) => c.url === TOKEN_URL).length - 1;
        return Promise.resolve(stub.tokenHandler(body, tokenCalls));
      }
      return Promise.resolve(json({ error: 'not_found', url }, 404));
    }),
  };
  return stub;
}

export function tokenCalls(stub: IdpStub): IdpCall[] {
  return stub.calls.filter((c) => c.url === TOKEN_URL);
}
