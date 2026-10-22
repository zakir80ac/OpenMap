// REQ-SEC-001 — the realm's `.well-known/openid-configuration`, fetched once per page load and cached in memory
// (the same promise is shared, so concurrent callers make one request). A failed fetch is evicted so the next
// attempt retries.
import { parseDiscovery, type OidcDiscovery } from './oidc';

const cache = new Map<string, Promise<OidcDiscovery>>();

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function loadDiscovery(url: string, fetchImpl: FetchLike = fetch): Promise<OidcDiscovery> {
  const cached = cache.get(url);
  if (cached !== undefined) return cached;
  const pending = (async (): Promise<OidcDiscovery> => {
    const response = await fetchImpl(url, { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error('OIDC discovery failed with status ' + String(response.status));
    return parseDiscovery(await response.json());
  })();
  cache.set(url, pending);
  pending.catch(() => {
    cache.delete(url);
  });
  return pending;
}

export function resetDiscoveryCache(): void {
  cache.clear();
}
