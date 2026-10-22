// REQ-UI-003 REQ-SEC-001 — GraphQL transport. The endpoint is built from NEXT_PUBLIC_API_URL, which next.config.mjs
// exposes from loadEnv().PUBLIC_API_URL; no origin, host or port appears in source. Every operation carries the
// Keycloak bearer token supplied by the AuthProvider through the injectable hooks below; an unauthenticated answer
// ends the session and starts sign-in again.
import { HTTP } from '@openmap/constants';

/** Path Mercurius serves the contract on, on the API origin (apps/api). Identical in every deployment. */
const GRAPHQL_PATH = '/graphql';

export function graphqlEndpoint(): string {
  const origin = process.env.NEXT_PUBLIC_API_URL;
  if (origin === undefined || origin === '') {
    throw new Error('NEXT_PUBLIC_API_URL is not set; next.config.ts exposes it from PUBLIC_API_URL');
  }
  return origin.replace(/\/$/, '') + GRAPHQL_PATH;
}

export interface GraphqlError {
  message: string;
  path?: ReadonlyArray<string | number>;
  extensions?: Record<string, unknown>;
}

interface GraphqlResponse<TData> {
  data?: TData | null;
  errors?: GraphqlError[];
}

export class GraphqlRequestError extends Error {
  constructor(
    public readonly errors: ReadonlyArray<GraphqlError>,
    public readonly status: number,
    public readonly unauthorized: boolean = false,
  ) {
    super(errors.map((e) => e.message).join('; ') || 'GraphQL request failed');
    this.name = 'GraphqlRequestError';
  }
}

export type Variables = Record<string, unknown>;

/**
 * Hooks the AuthProvider installs: where the access token comes from, and what to do when the API rejects it.
 * Defaults send no Authorization header and ignore rejections, so the transport works in tests without a provider.
 */
export interface AuthHooks {
  getAccessToken: () => string | undefined;
  onUnauthorized: (error: GraphqlRequestError) => void;
}

const noHooks: AuthHooks = { getAccessToken: () => undefined, onUnauthorized: () => undefined };
let authHooks: AuthHooks = noHooks;

export function setAuthHooks(hooks: AuthHooks | undefined): void {
  authHooks = hooks ?? noHooks;
}

/**
 * The API's AuthGuard rejects with UnauthorizedException. Over REST that is a 401; over GraphQL, Mercurius answers
 * 200 with the rejection in `errors`, so the extension code and the guard's own messages are recognised as well.
 */
const UNAUTHORIZED_MESSAGE = /(bearer token|authorization scheme|token verification|token lacks|token was not issued|unknown tenant|claim timestamp check|signature verification)/i;

export function isUnauthorized(status: number, errors: ReadonlyArray<GraphqlError>): boolean {
  if (status === HTTP.status.unauthorized) return true;
  return errors.some((error) => {
    const extensions = error.extensions ?? {};
    if (extensions['code'] === 'UNAUTHENTICATED' || extensions['statusCode'] === HTTP.status.unauthorized) return true;
    return UNAUTHORIZED_MESSAGE.test(error.message);
  });
}

/** POST one operation and return its data, or throw GraphqlRequestError with every error the server reported. */
export async function gql<TData>(query: string, variables?: Variables, signal?: AbortSignal): Promise<TData> {
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
  const accessToken = authHooks.getAccessToken();
  if (accessToken !== undefined) headers['authorization'] = 'Bearer ' + accessToken;
  const init: RequestInit = { method: 'POST', headers, body: JSON.stringify({ query, variables }) };
  if (signal !== undefined) init.signal = signal;
  const response = await fetch(graphqlEndpoint(), init);
  let payload: GraphqlResponse<TData>;
  try {
    payload = (await response.json()) as GraphqlResponse<TData>;
  } catch {
    payload = {};
  }
  const errors = payload.errors ?? [];
  if (!response.ok || errors.length > 0 || payload.data === undefined || payload.data === null) {
    const reported = errors.length > 0 ? errors : [{ message: response.statusText || (response.ok ? 'Empty response' : 'Invalid response') }];
    const unauthorized = isUnauthorized(response.status, reported);
    const error = new GraphqlRequestError(reported, response.status, unauthorized);
    if (unauthorized) authHooks.onUnauthorized(error);
    throw error;
  }
  return payload.data;
}
