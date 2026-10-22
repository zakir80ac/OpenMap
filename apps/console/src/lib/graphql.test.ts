// T-082 REQ-SEC-001 REQ-UI-003 — gql(): the bearer token from the auth hooks is attached, and an unauthenticated
// answer (HTTP 401, or Mercurius' 200 carrying the guard's rejection) invokes onUnauthorized and throws.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphqlRequestError, gql, isUnauthorized, setAuthHooks } from './graphql';

interface Captured {
  headers: Record<string, string>;
  body: string;
}

function respond(body: unknown, status: number, captured: Captured[]): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((_url: string, init?: RequestInit) => {
      captured.push({ headers: (init?.headers as Record<string, string> | undefined) ?? {}, body: typeof init?.body === 'string' ? init.body : '' });
      return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
    }),
  );
}

beforeEach(() => {
  process.env['NEXT_PUBLIC_API_URL'] = 'http://api.test';
});

afterEach(() => {
  setAuthHooks(undefined);
  vi.unstubAllGlobals();
});

describe('gql with auth hooks', () => {
  it('sends the access token as a Bearer Authorization header', async () => {
    const captured: Captured[] = [];
    respond({ data: { layers: [] } }, 200, captured);
    setAuthHooks({ getAccessToken: () => 'tok-123', onUnauthorized: () => undefined });
    await expect(gql('query Layers { layers { layer } }')).resolves.toEqual({ layers: [] });
    expect(captured[0]?.headers['authorization']).toBe('Bearer tok-123');
  });

  it('sends no Authorization header when no provider installed hooks', async () => {
    const captured: Captured[] = [];
    respond({ data: { layers: [] } }, 200, captured);
    await gql('query Layers { layers { layer } }');
    expect(captured[0]?.headers['authorization']).toBeUndefined();
  });

  it('reports a 401 to onUnauthorized and throws an unauthorized GraphqlRequestError', async () => {
    respond({ errors: [{ message: 'Unauthorized' }] }, 401, []);
    const onUnauthorized = vi.fn();
    setAuthHooks({ getAccessToken: () => 'expired', onUnauthorized });
    const failure = await gql('query Layers { layers { layer } }').catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(GraphqlRequestError);
    expect((failure as GraphqlRequestError).unauthorized).toBe(true);
    expect((failure as GraphqlRequestError).status).toBe(401);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("recognises the API guard's rejection inside a 200 GraphQL envelope", async () => {
    respond({ data: null, errors: [{ message: 'a bearer token is required', path: ['layers'] }] }, 200, []);
    const onUnauthorized = vi.fn();
    setAuthHooks({ getAccessToken: () => undefined, onUnauthorized });
    await expect(gql('query Layers { layers { layer } }')).rejects.toMatchObject({ unauthorized: true });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('does not treat ordinary resolver errors as unauthorized', async () => {
    respond({ data: null, errors: [{ message: 'CI not found' }] }, 200, []);
    const onUnauthorized = vi.fn();
    setAuthHooks({ getAccessToken: () => 'tok', onUnauthorized });
    await expect(gql('query Ci { ci(id: "x") { id } }')).rejects.toMatchObject({ unauthorized: false });
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});

describe('isUnauthorized', () => {
  it('matches by status, extension code, extension status and guard messages', () => {
    expect(isUnauthorized(401, [])).toBe(true);
    expect(isUnauthorized(200, [{ message: 'x', extensions: { code: 'UNAUTHENTICATED' } }])).toBe(true);
    expect(isUnauthorized(200, [{ message: 'x', extensions: { statusCode: 401 } }])).toBe(true);
    expect(isUnauthorized(200, [{ message: 'token was not issued for this client' }])).toBe(true);
    expect(isUnauthorized(200, [{ message: '"exp" claim timestamp check failed' }])).toBe(true);
    expect(isUnauthorized(200, [{ message: 'unknown tenant "acme"' }])).toBe(true);
    expect(isUnauthorized(500, [{ message: 'database unavailable' }])).toBe(false);
    expect(isUnauthorized(200, [{ message: 'Cannot query field "foo"' }])).toBe(false);
  });
});
