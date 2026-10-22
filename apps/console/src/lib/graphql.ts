// REQ-UI-003 — GraphQL transport. The endpoint is built from NEXT_PUBLIC_API_URL, which next.config.ts exposes
// from loadEnv().PUBLIC_API_URL; no origin, host or port appears in source.

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
}

interface GraphqlResponse<TData> {
  data?: TData | null;
  errors?: GraphqlError[];
}

export class GraphqlRequestError extends Error {
  constructor(
    public readonly errors: ReadonlyArray<GraphqlError>,
    public readonly status: number,
  ) {
    super(errors.map((e) => e.message).join('; ') || 'GraphQL request failed');
    this.name = 'GraphqlRequestError';
  }
}

export type Variables = Record<string, unknown>;

/** POST one operation and return its data, or throw GraphqlRequestError with every error the server reported. */
export async function gql<TData>(query: string, variables?: Variables, signal?: AbortSignal): Promise<TData> {
  const init: RequestInit = {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ query, variables }),
  };
  if (signal !== undefined) init.signal = signal;
  const response = await fetch(graphqlEndpoint(), init);
  let payload: GraphqlResponse<TData>;
  try {
    payload = (await response.json()) as GraphqlResponse<TData>;
  } catch {
    throw new GraphqlRequestError([{ message: response.statusText || 'Invalid response' }], response.status);
  }
  const errors = payload.errors ?? [];
  if (!response.ok || errors.length > 0 || payload.data === undefined || payload.data === null) {
    throw new GraphqlRequestError(
      errors.length > 0 ? errors : [{ message: response.statusText || 'Empty response' }],
      response.status,
    );
  }
  return payload.data;
}
