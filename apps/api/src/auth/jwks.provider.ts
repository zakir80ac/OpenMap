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

export function realmUrl(env: Pick<Env, 'KEYCLOAK_URL' | 'KEYCLOAK_REALM'>): URL {
  return new URL('realms/' + env.KEYCLOAK_REALM, baseUrl(env.KEYCLOAK_URL));
}

export function jwksUrl(env: Pick<Env, 'KEYCLOAK_URL' | 'KEYCLOAK_REALM'>): URL {
  return new URL('realms/' + env.KEYCLOAK_REALM + '/protocol/openid-connect/certs', baseUrl(env.KEYCLOAK_URL));
}

export const jwksProvider: Provider = {
  provide: JWKS,
  inject: [ENV],
  useFactory: (env: Env): KeyResolver => createRemoteJWKSet(jwksUrl(env)),
};
