// REQ-SEC-001 REQ-SEC-009 — OIDC building blocks, all pure: discovery document parsing, authorize and end_session URL
// builders, token response parsing, JWT payload decoding (for display only: the API verifies signatures, the browser
// never trusts a claim for authorisation), expiry arithmetic and callback parameter parsing.
import { AUTH, TIME } from '@openmap/constants';
import { base64UrlDecode } from './pkce';

export interface OidcDiscovery {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  endSessionEndpoint: string | undefined;
}

/** Ensures a base URL ends with a slash so relative paths append rather than replace the last segment. */
export function baseUrl(url: string): string {
  return url.endsWith('/') ? url : url + '/';
}

export function realmUrl(keycloakUrl: string, realm: string): string {
  return new URL('realms/' + encodeURIComponent(realm), baseUrl(keycloakUrl)).toString();
}

export function discoveryDocumentUrl(keycloakUrl: string, realm: string): string {
  return new URL(AUTH.discoveryPath, baseUrl(realmUrl(keycloakUrl, realm))).toString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value === '') throw new Error('OIDC discovery document lacks "' + key + '"');
  return value;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

export function parseDiscovery(value: unknown): OidcDiscovery {
  if (!isRecord(value)) throw new Error('OIDC discovery document is not an object');
  return {
    issuer: requiredString(value, 'issuer'),
    authorizationEndpoint: requiredString(value, 'authorization_endpoint'),
    tokenEndpoint: requiredString(value, 'token_endpoint'),
    endSessionEndpoint: optionalString(value, 'end_session_endpoint'),
  };
}

export interface AuthorizeRequest {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  state: string;
  nonce: string;
  codeChallenge: string;
  /** UI locale hint forwarded to the identity provider's login page. */
  uiLocale?: string;
}

export function buildAuthorizeUrl(request: AuthorizeRequest): string {
  const url = new URL(request.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', request.clientId);
  url.searchParams.set('redirect_uri', request.redirectUri);
  url.searchParams.set('scope', AUTH.scope);
  url.searchParams.set('state', request.state);
  url.searchParams.set('nonce', request.nonce);
  url.searchParams.set('code_challenge', request.codeChallenge);
  url.searchParams.set('code_challenge_method', AUTH.challengeMethod);
  if (request.uiLocale !== undefined) url.searchParams.set('ui_locales', request.uiLocale);
  return url.toString();
}

export interface EndSessionRequest {
  endSessionEndpoint: string;
  clientId: string;
  postLogoutRedirectUri: string;
  idToken: string | undefined;
}

/** RP-initiated logout (OIDC RP-Initiated Logout 1.0): the id_token_hint lets Keycloak skip its confirmation page. */
export function buildEndSessionUrl(request: EndSessionRequest): string {
  const url = new URL(request.endSessionEndpoint);
  url.searchParams.set('client_id', request.clientId);
  url.searchParams.set('post_logout_redirect_uri', request.postLogoutRedirectUri);
  if (request.idToken !== undefined) url.searchParams.set('id_token_hint', request.idToken);
  return url.toString();
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string | undefined;
  idToken: string | undefined;
  /** Absolute expiry of the access token in epoch milliseconds, computed from `expires_in` at receipt. */
  expiresAtMs: number;
}

export function expiresAtMs(nowMs: number, expiresInSeconds: number): number {
  return nowMs + expiresInSeconds * TIME.msPerSecond;
}

/** Milliseconds until the access token should be renewed: `refreshLeadMs` before expiry, never below the floor. */
export function refreshDelayMs(tokenExpiresAtMs: number, nowMs: number): number {
  return Math.max(AUTH.minRefreshDelayMs, tokenExpiresAtMs - nowMs - AUTH.refreshLeadMs);
}

export function isExpired(tokenExpiresAtMs: number, nowMs: number): boolean {
  return tokenExpiresAtMs <= nowMs;
}

export function parseTokenResponse(value: unknown, nowMs: number): TokenSet {
  if (!isRecord(value)) throw new Error('token response is not an object');
  const accessToken = requiredString(value, 'access_token');
  const tokenType = optionalString(value, 'token_type');
  if (tokenType !== undefined && tokenType.toLowerCase() !== 'bearer') throw new Error('unsupported token_type "' + tokenType + '"');
  const expiresIn = value['expires_in'];
  const seconds = typeof expiresIn === 'number' && Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : AUTH.fallbackExpiresInSeconds;
  return {
    accessToken,
    refreshToken: optionalString(value, 'refresh_token'),
    idToken: optionalString(value, 'id_token'),
    expiresAtMs: expiresAtMs(nowMs, seconds),
  };
}

/** Claims the console displays or compares. Everything is optional: a missing claim is shown as absent, never guessed. */
export interface JwtClaims {
  sub?: string;
  iss?: string;
  exp?: number;
  nonce?: string;
  azp?: string;
  preferred_username?: string;
  name?: string;
  email?: string;
  tenant?: string;
  roles?: string[];
  realm_access?: { roles?: string[] };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function optionalNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Decodes the payload of a compact JWS without verifying it. Display and nonce comparison only. */
export function decodeJwtPayload(token: string): JwtClaims {
  const segments = token.split('.');
  if (segments.length !== AUTH.jwtSegments) throw new Error('token is not a compact JWS');
  const payloadSegment = segments[1];
  if (payloadSegment === undefined || payloadSegment === '') throw new Error('token has an empty payload');
  const parsed: unknown = JSON.parse(base64UrlDecode(payloadSegment));
  if (!isRecord(parsed)) throw new Error('token payload is not an object');
  const realmAccess = isRecord(parsed['realm_access']) ? parsed['realm_access'] : undefined;
  const claims: JwtClaims = { roles: stringArray(parsed['roles']) };
  const sub = optionalString(parsed, 'sub');
  const iss = optionalString(parsed, 'iss');
  const exp = optionalNumber(parsed, 'exp');
  const nonce = optionalString(parsed, 'nonce');
  const azp = optionalString(parsed, 'azp');
  const preferredUsername = optionalString(parsed, 'preferred_username');
  const name = optionalString(parsed, 'name');
  const email = optionalString(parsed, 'email');
  const tenant = optionalString(parsed, 'tenant');
  if (sub !== undefined) claims.sub = sub;
  if (iss !== undefined) claims.iss = iss;
  if (exp !== undefined) claims.exp = exp;
  if (nonce !== undefined) claims.nonce = nonce;
  if (azp !== undefined) claims.azp = azp;
  if (preferredUsername !== undefined) claims.preferred_username = preferredUsername;
  if (name !== undefined) claims.name = name;
  if (email !== undefined) claims.email = email;
  if (tenant !== undefined) claims.tenant = tenant;
  if (realmAccess !== undefined) claims.realm_access = { roles: stringArray(realmAccess['roles']) };
  return claims;
}

/** Realm roles as the API computes them: the union of `realm_access.roles` and the flat `roles` claim, de-duplicated. */
export function realmRoles(claims: JwtClaims): string[] {
  return [...new Set([...(claims.realm_access?.roles ?? []), ...(claims.roles ?? [])])].sort();
}

/** Name shown in the user menu: full name, then preferred_username, then the subject. */
export function displayName(claims: JwtClaims): string {
  return claims.name ?? claims.preferred_username ?? claims.sub ?? '';
}

export interface CallbackParams {
  code: string | undefined;
  state: string | undefined;
  error: string | undefined;
  errorDescription: string | undefined;
}

export function parseCallbackParams(search: string): CallbackParams {
  const params = new URLSearchParams(search);
  const read = (key: string): string | undefined => {
    const value = params.get(key);
    return value === null || value === '' ? undefined : value;
  };
  return { code: read('code'), state: read('state'), error: read('error'), errorDescription: read('error_description') };
}

/** Only a same-origin absolute path is accepted as a return target; anything else falls back (open-redirect guard). */
export function safeReturnPath(candidate: string | undefined, fallback: string): string {
  if (candidate === undefined || !candidate.startsWith('/') || candidate.startsWith('//') || candidate.includes('\\')) return fallback;
  return candidate;
}
