// T-586 REQ-SEC-011 (ADR-068) — the stores the reconciler writes to, reached over TLS with the clients the services use,
// verified against the internal services CA that loadEnv adds to the default trust (SERVICE_CA_PATH): Valkey (ioredis,
// rediss://), Memgraph (the graph repository, bolt+s://), Meilisearch (the search sink, https) and OpenBao (fetch,
// https). The same stores refuse a plain connection, and a TLS connection that does not trust the CA fails.
import { randomUUID } from 'node:crypto';
import { loadEnv } from '@openmap/config';
import { createGraphRepository } from '@openmap/graph';
import { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';
import { createMeilisearchSink } from './worker/dispatcher.js';

const env = loadEnv();
const tenantId = randomUUID();

/** The same address with the plain protocol in place of the TLS one. */
function plain(url: string, from: string, to: string): string {
  expect(url.startsWith(from + '://')).toBe(true);
  return to + url.slice(from.length);
}

async function ping(url: string, tls?: { rejectUnauthorized: boolean; ca: string[] }): Promise<string> {
  const client = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 0,
    connectTimeout: 5_000,
    retryStrategy: () => null,
    ...(tls === undefined ? {} : { tls }),
  });
  client.on('error', () => undefined);
  try {
    await client.connect();
    return await client.ping();
  } finally {
    client.disconnect();
  }
}

describe('stores over TLS (integration)', () => {
  it('reaches Valkey over rediss:// and is refused in plain text or without the CA', async () => {
    expect(await ping(env.VALKEY_URL)).toBe('PONG');
    await expect(ping(plain(env.VALKEY_URL, 'rediss', 'redis'))).rejects.toThrow();
    // A client that trusts only an unrelated root: the server's chain does not verify.
    await expect(ping(env.VALKEY_URL, { rejectUnauthorized: true, ca: [] })).rejects.toThrow();
  });

  it('reads Memgraph over bolt+s:// and is refused over plain bolt://', async () => {
    const graph = createGraphRepository(env);
    try {
      expect(await graph.getCi(tenantId, randomUUID(), null)).toBeNull();
    } finally {
      await graph.close();
    }
    const insecure = createGraphRepository({ ...env, MEMGRAPH_URL: plain(env.MEMGRAPH_URL, 'bolt+s', 'bolt') });
    try {
      await expect(insecure.getCi(tenantId, randomUUID(), null)).rejects.toThrow();
    } finally {
      await insecure.close();
    }
  });

  it('writes to Meilisearch over https and is refused over http', async () => {
    const health = await fetch(new URL('health', env.MEILI_URL.endsWith('/') ? env.MEILI_URL : env.MEILI_URL + '/'));
    expect(health.ok).toBe(true);
    // A tenant without an index: Meilisearch answers 404, which the sink accepts.
    await createMeilisearchSink(env).dropTenant(tenantId);
    await expect(fetch(plain(env.MEILI_URL, 'https', 'http') + '/health')).rejects.toThrow();
  });

  it('answers on OpenBao over https and refuses plain http', async () => {
    const res = await fetch(env.OPENBAO_ADDR + '/v1/sys/health');
    expect(res.status).toBe(200);
    // The TLS listener answers a plain request with 400 and no data.
    const insecure = await fetch(plain(env.OPENBAO_ADDR, 'https', 'http') + '/v1/sys/health').then(
      (r) => r.status,
      () => 0,
    );
    expect(insecure === 0 || insecure === 400).toBe(true);
  });
});
