// T-212 REQ-CMDB-023 (ADR-039) — the bundled endoflife.date snapshot: every catalogue product is present with releases
// the contract reads; the fetcher asks for each product, keeps the publisher's rows as they came and reports a product
// that fails instead of inventing it.
import { LIFECYCLE } from '@openmap/constants';
import { describe, expect, it } from 'vitest';
import { LIFECYCLE_SNAPSHOT_PATH, fetchEndOfLifeCatalogue, readLifecycleSnapshot, snapshotEntries } from './lifecycle.js';

describe('lifecycle snapshot', () => {
  it('bundles every catalogue product with readable releases', () => {
    const snapshot = readLifecycleSnapshot(LIFECYCLE_SNAPSHOT_PATH);
    expect(snapshot.source).toBe('endoflife.date');
    expect(Object.keys(snapshot.products).sort()).toEqual(LIFECYCLE.products.map((p) => p.product).sort());
    const entries = snapshotEntries(snapshot);
    for (const p of LIFECYCLE.products) expect(entries.some((e) => e.product === p.product), p.product).toBe(true);
    const ws2012r2 = entries.find((e) => e.product === 'windows-server' && e.cycle === '2012-r2');
    expect(ws2012r2?.label).toBe('Windows Server 2012 R2');
    expect(ws2012r2?.endOfSupport).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
  });

  it('fetches each product and reports failures', async () => {
    const asked: string[] = [];
    const fake = (async (input: URL | RequestInfo) => {
      const url = String(input);
      asked.push(url);
      if (url.endsWith('/ubuntu.json')) return new Response('nope', { status: 503 });
      if (url.endsWith('/debian.json')) return new Response(JSON.stringify({ not: 'a list' }), { status: 200 });
      return new Response(JSON.stringify([{ cycle: '1', eol: false }]), { status: 200 });
    }) as typeof fetch;
    const report = await fetchEndOfLifeCatalogue('http://catalogue.test/api', fake, new Date('2026-11-07T00:00:00.000Z'));
    expect(asked).toHaveLength(LIFECYCLE.products.length);
    expect(asked.every((u) => u.startsWith('http://catalogue.test/api/'))).toBe(true);
    expect(report.failed.map((f) => f.product).sort()).toEqual(['debian', 'ubuntu']);
    expect(report.snapshot.products['ubuntu']).toBeUndefined();
    expect(report.snapshot.products['rhel']?.releases).toEqual([{ cycle: '1', eol: false }]);
    expect(report.snapshot.fetchedAt).toBe('2026-11-07T00:00:00.000Z');
  });
});
