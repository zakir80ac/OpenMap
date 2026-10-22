// REQ-SEC-001 — token endpoint calls for the public client: authorization_code (with the PKCE verifier) and
// refresh_token grants, form-encoded as RFC 6749 requires. No client secret exists for a public client.
import type { FetchLike } from './discovery';
import { parseTokenResponse, type TokenSet } from './oidc';

export class TokenRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    description: string,
  ) {
    super(description === '' ? code : code + ': ' + description);
    this.name = 'TokenRequestError';
  }
}

async function postGrant(tokenEndpoint: string, body: URLSearchParams, fetchImpl: FetchLike, nowMs: number): Promise<TokenSet> {
  const response = await fetchImpl(tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: body.toString(),
  });
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new TokenRequestError(response.status, 'invalid_response', response.statusText);
  }
  if (!response.ok) {
    const record = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {};
    const code = typeof record['error'] === 'string' ? record['error'] : 'token_request_failed';
    const description = typeof record['error_description'] === 'string' ? record['error_description'] : '';
    throw new TokenRequestError(response.status, code, description);
  }
  return parseTokenResponse(payload, nowMs);
}

export interface ExchangeCodeRequest {
  tokenEndpoint: string;
  clientId: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
}

export function exchangeCode(request: ExchangeCodeRequest, nowMs: number, fetchImpl: FetchLike = fetch): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: request.clientId,
    code: request.code,
    code_verifier: request.codeVerifier,
    redirect_uri: request.redirectUri,
  });
  return postGrant(request.tokenEndpoint, body, fetchImpl, nowMs);
}

export interface RefreshRequest {
  tokenEndpoint: string;
  clientId: string;
  refreshToken: string;
}

export function refreshGrant(request: RefreshRequest, nowMs: number, fetchImpl: FetchLike = fetch): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: request.clientId,
    refresh_token: request.refreshToken,
  });
  return postGrant(request.tokenEndpoint, body, fetchImpl, nowMs);
}
