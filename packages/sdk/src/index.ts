// REQ-CORE-019 (ADR-049) — @openmap/sdk: the OpenMap REST and GraphQL client. Every REST method is a route of the
// contract's REST_ROUTES table, typed from its schemas (query and body as accepted, responses as returned), so the SDK,
// the API and the OpenAPI document cannot drift apart. It runs wherever fetch does (Node 18+, browsers); a token or a
// token provider (for example the automation client's credentials grant) authenticates each call.
import { REST_BASE_PATH, REST_ROUTES, restPath, type RestRouteId } from '@openmap/contracts';
import type { z } from 'zod';

type Route<K extends RestRouteId> = (typeof REST_ROUTES)[K];
export type RouteQuery<K extends RestRouteId> = Route<K>['query'] extends z.ZodType ? z.input<Route<K>['query']> : undefined;
export type RouteBody<K extends RestRouteId> = Route<K>['body'] extends z.ZodType ? z.input<Route<K>['body']> : undefined;
export type RouteResponse<K extends RestRouteId> = z.output<Route<K>['response']>;

export interface OpenMapClientOptions {
  /** API origin: scheme, host and port, with no path (the SDK adds /api/v1 and /graphql). */
  baseUrl: string;
  /** A bearer token, or a function returning one (called before every request, so it may refresh). */
  token: string | (() => string | Promise<string>);
  /** Defaults to the global fetch. */
  fetch?: typeof fetch;
}

/** An error the API answered with: its HTTP status and message. */
export class OpenMapError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly route: string,
  ) {
    super(message);
    this.name = 'OpenMapError';
  }
}

interface CallInput {
  params?: Readonly<Record<string, string>>;
  query?: Readonly<Record<string, unknown>>;
  body?: unknown;
}

function queryString(query: Readonly<Record<string, unknown>> | undefined): string {
  if (query === undefined) return '';
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    search.set(key, Array.isArray(value) ? value.map(String).join(',') : String(value));
  }
  const s = search.toString();
  return s === '' ? '' : '?' + s;
}

export class OpenMapClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: OpenMapClientOptions) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  private async bearer(): Promise<string> {
    const t = this.options.token;
    return typeof t === 'string' ? t : await t();
  }

  /** Calls one route of the table; the typed methods below are thin wrappers over it. */
  async call<K extends RestRouteId>(id: K, input: CallInput = {}): Promise<RouteResponse<K>> {
    const route = REST_ROUTES[id];
    const url = this.options.baseUrl.replace(/\/+$/, '') + REST_BASE_PATH + restPath(route.path, input.params ?? {}) + queryString(input.query);
    const res = await this.fetchImpl(url, {
      method: route.method,
      headers: { accept: 'application/json', authorization: 'Bearer ' + (await this.bearer()), ...(input.body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    });
    const text = await res.text();
    const json: unknown = text === '' ? null : JSON.parse(text);
    if (!res.ok) {
      const message = json !== null && typeof json === 'object' && 'message' in json ? String((json as { message: unknown }).message) : res.statusText;
      throw new OpenMapError(res.status, message, id);
    }
    return json as RouteResponse<K>;
  }

  /** Any GraphQL operation, for what REST does not cover; errors become one OpenMapError. */
  async graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const res = await this.fetchImpl(this.options.baseUrl.replace(/\/+$/, '') + '/graphql', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', authorization: 'Bearer ' + (await this.bearer()) },
      body: JSON.stringify({ query, variables }),
    });
    const body = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
    if (body.errors !== undefined && body.errors.length > 0) throw new OpenMapError(res.status, body.errors.map((e) => e.message).join('; '), 'graphql');
    if (body.data === undefined) throw new OpenMapError(res.status, 'no data', 'graphql');
    return body.data;
  }

  readonly cis = {
    list: (query: RouteQuery<'listCis'> = {}) => this.call('listCis', { query }),
    get: (id: string, query: RouteQuery<'getCi'> = {}) => this.call('getCi', { params: { id }, query }),
    patchAttributes: (id: string, attributes: Record<string, unknown>) => this.call('patchCiAttributes', { params: { id }, body: { attributes } }),
    relationships: (id: string, query: RouteQuery<'listCiRelationships'> = {}) => this.call('listCiRelationships', { params: { id }, query }),
    impact: (id: string, query: RouteQuery<'getCiImpact'> = {}) => this.call('getCiImpact', { params: { id }, query }),
  };

  readonly relationships = {
    create: (body: RouteBody<'createRelationship'>) => this.call('createRelationship', { body }),
    retire: (id: string) => this.call('retireRelationship', { params: { id } }),
  };

  /** Every CI the filter selects, page by page, without holding more than a page in memory. */
  async *allCis(query: Omit<RouteQuery<'listCis'>, 'after'> = {}): AsyncGenerator<RouteResponse<'listCis'>['items'][number]> {
    let after: string | undefined;
    for (;;) {
      const page = await this.call('listCis', { query: { ...query, after } });
      yield* page.items;
      if (!page.pageInfo.hasNextPage || page.pageInfo.endCursor === null) return;
      after = page.pageInfo.endCursor;
    }
  }

  search(q: string, query: Omit<RouteQuery<'search'>, 'q'> = {}): Promise<RouteResponse<'search'>> {
    return this.call('search', { query: { ...query, q } });
  }

  incidents(query: RouteQuery<'listIncidents'> = {}): Promise<RouteResponse<'listIncidents'>> {
    return this.call('listIncidents', { query });
  }

  connectivity(): Promise<RouteResponse<'getConnectivity'>> {
    return this.call('getConnectivity');
  }
}
