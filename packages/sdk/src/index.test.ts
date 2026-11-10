// T-483 REQ-CORE-019 (ADR-049) — the SDK over a stubbed fetch:
// - each method calls its route's method and path with the bearer token;
// - query lists are joined with commas, and bodies are JSON;
// - allCis follows the cursor pages;
// - an API error becomes an OpenMapError with its status and message;
// - graphql() posts the operation and returns its data.
// T-623 REQ-INT-011 (ADR-072): the inventory methods call their routes, asking the YAML-first routes for JSON.
import { describe, expect, it } from 'vitest';
import { OpenMapClient, OpenMapError } from './index.js';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function client(responses: Array<{ status?: number; body: unknown }>, token: string | (() => Promise<string>) = 'tok') {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, method: init.method ?? 'GET', headers: init.headers as Record<string, string>, body: init.body === undefined ? undefined : JSON.parse(String(init.body)) });
    const r = responses.shift() ?? { body: null };
    return new Response(r.body === null ? '' : JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  return { sdk: new OpenMapClient({ baseUrl: 'https://openmap.test/', token, fetch: fetchImpl }), calls };
}

const ID = '00000000-0000-4000-8000-000000000001';

describe('OpenMapClient', () => {
  it('calls each route with its method, path, query and token', async () => {
    const { sdk, calls } = client([{ body: { items: [], pageInfo: { endCursor: null, hasNextPage: false }, totalCount: 0 } }, { body: {} }, { status: 201, body: {} }, { body: {} }], async () => 'fresh');
    await sdk.cis.list({ types: 'host,vm', first: 50 });
    await sdk.cis.patchAttributes(ID, { owner: 'DBA' });
    await sdk.relationships.create({ type: 'depends_on', fromCiId: ID, toCiId: ID });
    await sdk.cis.impact(ID, { direction: 'downstream' });
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ['GET', 'https://openmap.test/api/v1/cis?types=host%2Cvm&first=50'],
      ['PATCH', 'https://openmap.test/api/v1/cis/' + ID + '/attributes'],
      ['POST', 'https://openmap.test/api/v1/relationships'],
      ['GET', 'https://openmap.test/api/v1/cis/' + ID + '/impact?direction=downstream'],
    ]);
    expect(calls[0]?.headers['authorization']).toBe('Bearer fresh');
    expect(calls[1]?.body).toEqual({ attributes: { owner: 'DBA' } });
  });

  it('follows the cursor pages', async () => {
    const page = (ids: string[], endCursor: string | null) => ({ body: { items: ids.map((id) => ({ id })), pageInfo: { endCursor, hasNextPage: endCursor !== null }, totalCount: 3 } });
    const { sdk, calls } = client([page(['a', 'b'], 'c1'), page(['c'], null)]);
    const seen: string[] = [];
    for await (const ci of sdk.allCis({ layers: 'hardware' })) seen.push(ci.id);
    expect(seen).toEqual(['a', 'b', 'c']);
    expect(calls[1]?.url).toContain('after=c1');
  });

  it('raises the API error with its status, and runs GraphQL', async () => {
    const { sdk } = client([{ status: 403, body: { statusCode: 403, error: 'Forbidden', message: 'requires one of the roles: openmap-operator' } }, { body: { data: { ci: { id: ID } } } }]);
    await expect(sdk.relationships.retire(ID)).rejects.toMatchObject({ name: 'OpenMapError', status: 403, route: 'retireRelationship' });
    await expect(sdk.graphql<{ ci: { id: string } }>('query($id: UUID!) { ci(id: $id) { id } }', { id: ID })).resolves.toEqual({ ci: { id: ID } });
    expect(new OpenMapError(500, 'x', 'getCi')).toBeInstanceOf(Error);
  });

  it('calls the inventory routes, asking the YAML-first ones for JSON', async () => {
    const { sdk, calls } = client([{ body: {} }, { body: {} }, { body: {} }, { body: {} }, { body: {} }]);
    await sdk.inventory.ansible({ sites: 'HQ', groupBy: 'site,service' });
    await sdk.inventory.salt({ user: 'ops', port: 2222 });
    await sdk.inventory.puppet({ environment: 'staging' });
    await sdk.inventory.puppetNode('web-01.bank.local');
    await sdk.inventory.chef({ tags: 'pci' });
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ['GET', 'https://openmap.test/api/v1/inventory/ansible?sites=HQ&groupBy=site%2Cservice'],
      ['GET', 'https://openmap.test/api/v1/inventory/salt?user=ops&port=2222&format=json'],
      ['GET', 'https://openmap.test/api/v1/inventory/puppet?environment=staging&format=json'],
      ['GET', 'https://openmap.test/api/v1/inventory/puppet/nodes/web-01.bank.local?format=json'],
      ['GET', 'https://openmap.test/api/v1/inventory/chef?tags=pci'],
    ]);
  });
});
