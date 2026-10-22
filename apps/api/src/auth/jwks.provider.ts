// REQ-CORE-012 — key resolver for JWT verification. Production fetches Keycloak's JWKS endpoint;
// tests override this provider with a local key set, so there is no "auth disabled" switch anywhere.
import type { Provider } from '@nestjs/common';
import { createRemoteJWKSet, type JWTVerifyGetKey } from 'jose';
import { ENV, type Env } from '../config/env.module.js';

export const JWKS = Symbol('JWKS');
export type KeyResolver = JWTVerifyGetKey;

/** Ensures a base URL ends with a slash so relative paths append rather than replace. */
export function baseUrl(url: string): string {
  return url.endsWith('/') ? url : url + '/';
}

/**
 * The realm as the browser reaches it (REQ-SEC-001): Keycloak writes this origin into every token's `iss`
 * (KC_HOSTNAME pins it in deploy/compose), so verification compares against PUBLIC_KEYCLOAK_URL even when the API
 * itself reaches Keycloak over an internal address.
 */
export function realmUrl(env: Pick<Env, 'PUBLIC_KEYCLOAK_URL' | 'KEYCLOAK_REALM'>): URL {
  return new URL('realms/' + env.KEYCLOAK_REALM, baseUrl(env.PUBLIC_KEYCLOAK_URL));
}

/** Key set fetched over the backchannel address (KEYCLOAK_URL), which may differ from the public origin. */
export function jwksUrl(env: Pick<Env, 'KEYCLOAK_URL' | 'KEYCLOAK_REALM'>): URL {
  return new URL('realms/' + env.KEYCLOAK_REALM + '/protocol/openid-connect/certs', baseUrl(env.KEYCLOAK_URL));
}

export const jwksProvider: Provider = {
  provide: JWKS,
  inject: [ENV],
  useFactory: (env: Env): KeyResolver => createRemoteJWKSet(jwksUrl(env)),
};
