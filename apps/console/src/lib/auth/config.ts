// REQ-SEC-001 — the browser-side OIDC client settings. next.config.mjs exposes them as NEXT_PUBLIC_* from
// loadEnv() (PUBLIC_KEYCLOAK_URL, KEYCLOAK_REALM, KEYCLOAK_CLIENT_ID); no host or client id appears in source.
import { AUTH } from '@openmap/constants';
import type { Locale } from '@openmap/i18n';
import { localizedHref } from '@/lib/locale-path';

export interface ConsoleAuthConfig {
  keycloakUrl: string;
  realm: string;
  clientId: string;
}

function required(name: string, value: string | undefined): string {
  if (value === undefined || value === '') throw new Error(name + ' is not set; next.config.mjs exposes it from loadEnv()');
  return value;
}

export function authConfig(): ConsoleAuthConfig {
  return {
    keycloakUrl: required('NEXT_PUBLIC_KEYCLOAK_URL', process.env.NEXT_PUBLIC_KEYCLOAK_URL),
    realm: required('NEXT_PUBLIC_KEYCLOAK_REALM', process.env.NEXT_PUBLIC_KEYCLOAK_REALM),
    clientId: required('NEXT_PUBLIC_KEYCLOAK_CLIENT_ID', process.env.NEXT_PUBLIC_KEYCLOAK_CLIENT_ID),
  };
}

/** Locale-prefixed callback route the identity provider redirects to. */
export function callbackRoute(locale: Locale): string {
  return localizedHref(locale, AUTH.callbackPath);
}

/** Absolute redirect URI on the origin that served the page: whichever public host the deployment uses. */
export function callbackUri(origin: string, locale: Locale): string {
  return origin + callbackRoute(locale);
}

export function isCallbackRoute(pathname: string, locale: Locale): boolean {
  return pathname === callbackRoute(locale) || pathname === callbackRoute(locale) + '/';
}
