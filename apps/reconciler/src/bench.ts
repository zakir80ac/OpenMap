// REQ-PERF-003 REQ-CORE-013 — in-process micro-benchmark of the pure reconciliation path: contract
// parse, reconcile against an empty store, envelope construction and checksums, per collector
// result. Usage: pnpm --filter @openmap/reconciler bench -- <results.ndjson>
import { readFileSync } from 'node:fs';
import { TIME } from '@openmap/constants';
import { collectorResultSchema, type Ci } from '@openmap/contracts';
import { envelope } from './core/events.js';
import { MapIdentityIndex, MapRefIndex } from './core/identity.js';
import { checksum } from './core/merge.js';
import { reconcile, type StoredLookup } from './core/reconcile.js';

function emptyLookup(): StoredLookup {
  return { index: new MapIdentityIndex(), refs: new MapRefIndex(), getCi: () => undefined, storedRefKey: () => undefined, findRelationship: () => undefined };
}

function main(): void {
  const [, , file] = process.argv;
  if (!file) throw new Error('usage: bench <results.ndjson>');
  const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
  const totals = { parseMs: 0, reconcileMs: 0, envelopeMs: 0, checksumMs: 0, cis: 0, relationships: 0, events: 0 };
  for (const line of lines) {
    const raw = JSON.parse(line) as unknown;
    const t0 = performance.now();
    const result = collectorResultSchema.parse(raw);
    const t1 = performance.now();
    const out = reconcile(result, emptyLookup());
    const t2 = performance.now();
    for (const ci of out.created) envelope(result.tenantId, 'openmap.ci.created', ci.id, { ci });
    const t3 = performance.now();
    for (const ci of out.created as Ci[]) checksum(ci.type, ci.identity, ci.attributes);
    const t4 = performance.now();
    totals.parseMs += t1 - t0;
    totals.reconcileMs += t2 - t1;
    totals.envelopeMs += t3 - t2;
    totals.checksumMs += t4 - t3;
    totals.cis += result.cis.length;
    totals.relationships += result.relationships.length;
    totals.events += out.events.length;
    console.log(JSON.stringify({ cis: result.cis.length, relationships: result.relationships.length, parseMs: Math.round(t1 - t0), reconcileMs: Math.round(t2 - t1), envelopeOnlyMs: Math.round(t3 - t2), checksumOnlyMs: Math.round(t4 - t3) }));
  }
  const perSecond = (n: number, ms: number): number => (ms > 0 ? Math.round((n / ms) * TIME.msPerSecond) : 0);
  console.log(JSON.stringify({ msg: 'bench', ...totals, cisPerSecondReconcile: perSecond(totals.cis, totals.reconcileMs), envelopesPerSecond: perSecond(totals.events, totals.envelopeMs) }));
}

main();
