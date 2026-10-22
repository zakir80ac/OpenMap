// T-081 REQ-SEC-001 REQ-SEC-009 — OIDC helpers: discovery URL and parsing, authorize and end_session URLs, token
// response parsing, display-only JWT decoding, expiry and refresh arithmetic, callback parameters, return paths.
import { AUTH } from '@openmap/constants';
import { describe, expect, it } from 'vitest';
import { CLIENT_ID, discoveryDocument, END_SESSION_URL, IDP_ORIGIN, ISSUER, makeJwt, REALM } from './__tests__/helpers';
import {
  buildAuthorizeUrl,
  buildEndSessionUrl,
  decodeJwtPayload,
  discoveryDocumentUrl,
  displayName,
  expiresAtMs,
  isExpired,
  parseCallbackParams,
  parseDiscovery,
  parseTokenResponse,
  realmRoles,
  realmUrl,
  refreshDelayMs,
  safeReturnPath,
} from './oidc';

describe('discovery', () => {
  it('builds the realm and discovery URLs with or without a trailing slash on the base', () => {
    expect(realmUrl(IDP_ORIGIN, REALM)).toBe(ISSUER);
    expect(realmUrl(IDP_ORIGIN + '/', REALM)).toBe(ISSUER);
    expect(discoveryDocumentUrl(IDP_ORIGIN, REALM)).toBe(ISSUER + '/.well-known/openid-configuration');
  });
  it('parses the endpoints the console needs and rejects a document missing one', () => {
    const doc = parseDiscovery(discoveryDocument);
    expect(doc.authorizationEndpoint).toBe(discoveryDocument.authorization_endpoint);
    expect(doc.tokenEndpoint).toBe(discoveryDocument.token_endpoint);
    expect(doc.endSessionEndpoint).toBe(END_SESSION_URL);
    expect(parseDiscovery({ ...discoveryDocument, end_session_endpoint: undefined }).endSessionEndpoint).toBeUndefined();
    expect(() => parseDiscovery({ issuer: ISSUER })).toThrow(/authorization_endpoint/);
    expect(() => parseDiscovery(null)).toThrow(/not an object/);
  });
});

describe('authorize and end_session URLs', () => {
  it('carries every Authorization Code + PKCE parameter', () => {
    const url = new URL(
      buildAuthorizeUrl({
        authorizationEndpoint: discoveryDocument.authorization_endpoint,
        clientId: CLIENT_ID,
        redirectUri: 'http://console.test/en/auth/callback',
        state: 'st',
        nonce: 'nn',
        codeChallenge: 'ch',
        uiLocale: 'ar',
      }),
    );
    expect(url.origin + url.pathname).toBe(discoveryDocument.authorization_endpoint);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: CLIENT_ID,
      redirect_uri: 'http://console.test/en/auth/callback',
      scope: AUTH.scope,
      state: 'st',
      nonce: 'nn',
      code_challenge: 'ch',
      code_challenge_method: 'S256',
      ui_locales: 'ar',
    });
  });
  it('builds an RP-initiated logout URL with the id_token_hint when one is held', () => {
    const withHint = new URL(buildEndSessionUrl({ endSessionEndpoint: END_SESSION_URL, clientId: CLIENT_ID, postLogoutRedirectUri: 'http://console.test/en', idToken: 'idt' }));
    expect(withHint.searchParams.get('id_token_hint')).toBe('idt');
    expect(withHint.searchParams.get('post_logout_redirect_uri')).toBe('http://console.test/en');
    expect(withHint.searchParams.get('client_id')).toBe(CLIENT_ID);
    const withoutHint = new URL(buildEndSessionUrl({ endSessionEndpoint: END_SESSION_URL, clientId: CLIENT_ID, postLogoutRedirectUri: 'http://console.test/en', idToken: undefined }));
    expect(withoutHint.searchParams.has('id_token_hint')).toBe(false);
  });
});

describe('token responses', () => {
  const now = 1_700_000_000_000;
  it('computes the absolute expiry from expires_in and keeps the optional tokens', () => {
    const set = parseTokenResponse({ access_token: 'a', refresh_token: 'r', id_token: 'i', token_type: 'Bearer', expires_in: 900 }, now);
    expect(set).toEqual({ accessToken: 'a', refreshToken: 'r', idToken: 'i', expiresAtMs: now + 900_000 });
  });
  it('falls back to the configured lifetime when expires_in is missing and rejects non-bearer tokens', () => {
    expect(parseTokenResponse({ access_token: 'a' }, now).expiresAtMs).toBe(expiresAtMs(now, AUTH.fallbackExpiresInSeconds));
    expect(() => parseTokenResponse({ access_token: 'a', token_type: 'MAC' }, now)).toThrow(/token_type/);
    expect(() => parseTokenResponse({ refresh_token: 'r' }, now)).toThrow(/access_token/);
  });
  it('schedules renewal before expiry and never below the floor', () => {
    const expiresAt = now + 900_000;
    expect(refreshDelayMs(expiresAt, now)).toBe(900_000 - AUTH.refreshLeadMs);
    expect(refreshDelayMs(now + 1_000, now)).toBe(AUTH.minRefreshDelayMs);
    expect(isExpired(expiresAt, now)).toBe(false);
    expect(isExpired(expiresAt, expiresAt)).toBe(true);
  });
});

describe('JWT display decoding', () => {
  it('reads the claims the console shows and merges realm roles from both claim shapes', () => {
    const claims = decodeJwtPayload(
      makeJwt({ sub: 's', preferred_username: 'admin', name: 'OpenMap Admin', tenant: 'default', roles: ['openmap-admin'], realm_access: { roles: ['openmap-auditor', 'openmap-admin'] }, nonce: 'n1', exp: 1 }),
    );
    expect(claims.preferred_username).toBe('admin');
    expect(claims.tenant).toBe('default');
    expect(claims.nonce).toBe('n1');
    expect(realmRoles(claims)).toEqual(['openmap-admin', 'openmap-auditor']);
    expect(displayName(claims)).toBe('OpenMap Admin');
    expect(displayName({ preferred_username: 'ops' })).toBe('ops');
    expect(displayName({ sub: 'only-sub' })).toBe('only-sub');
  });
  it('rejects anything that is not a three-segment JWS', () => {
    expect(() => decodeJwtPayload('nope')).toThrow(/compact JWS/);
    expect(() => decodeJwtPayload('a..c')).toThrow(/empty payload/);
  });
});

describe('callback parameters and return paths', () => {
  it('reads code, state and error details from the query string', () => {
    expect(parseCallbackParams('?code=c1&state=s1')).toEqual({ code: 'c1', state: 's1', error: undefined, errorDescription: undefined });
    expect(parseCallbackParams('?error=access_denied&error_description=User%20cancelled&state=s1')).toEqual({
      code: undefined,
      state: 's1',
      error: 'access_denied',
      errorDescription: 'User cancelled',
    });
  });
  it('only accepts same-origin absolute paths as return targets', () => {
    expect(safeReturnPath('/en/cmdb?q=db', '/en')).toBe('/en/cmdb?q=db');
    expect(safeReturnPath('//evil.test/x', '/en')).toBe('/en');
    expect(safeReturnPath('http://evil.test', '/en')).toBe('/en');
    expect(safeReturnPath(undefined, '/ar')).toBe('/ar');
  });
});
