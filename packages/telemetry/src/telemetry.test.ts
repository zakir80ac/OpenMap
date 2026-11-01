// T-107 REQ-CORE-014 — the metrics listener serves the registry, liveness and readiness (503 when the check fails),
// and withSpan returns the value or records the failure and re-throws.
import { describe, expect, it } from 'vitest';
import { Counter, createMetricsServer, createRegistry, withSpan } from './index.js';

describe('metrics server', () => {
  it('serves /metrics, /healthz and /readyz', async () => {
    const registry = createRegistry();
    const counter = new Counter({ name: 'openmap_test_total', help: 'test', registers: [registry] });
    counter.inc(3);
    let ready = true;
    const server = await createMetricsServer({ registry, port: 0, path: '/metrics', ready: async () => ready });
    const base = 'http://127.0.0.1:' + String(server.port);
    const metrics = await fetch(base + '/metrics');
    expect(metrics.status).toBe(200);
    expect(await metrics.text()).toContain('openmap_test_total 3');
    expect((await fetch(base + '/healthz')).status).toBe(200);
    expect((await fetch(base + '/readyz')).status).toBe(200);
    ready = false;
    expect((await fetch(base + '/readyz')).status).toBe(503);
    expect((await fetch(base + '/nope')).status).toBe(404);
    await server.close();
  });
});

describe('withSpan', () => {
  it('returns the value and propagates failures', async () => {
    expect(await withSpan('test', 'work', { a: 1 }, async () => 42)).toBe(42);
    await expect(withSpan('test', 'work', {}, async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
  });
});
