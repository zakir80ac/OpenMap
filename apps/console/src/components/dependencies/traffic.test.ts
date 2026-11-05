// T-151 REQ-DEP-002 (ADR-029) — the observed-traffic reading: derived edges are told from collector-asserted ones by
// their attribute, read in the root's direction, ordered busiest first, with byte volumes in binary units.
import { describe, expect, it } from 'vitest';
import type { CiSummary, RelationshipRow } from '@/lib/queries';
import { formatBytes, isDerivedFromFlows, observedTraffic } from './traffic';

const ci = (id: string, name: string): CiSummary =>
  ({ id, name, displayName: name, type: 'host', layer: 'hardware', health: 'healthy' }) as unknown as CiSummary;
const root = ci('root', 'api-01');
const db = ci('db', 'db-01');
const web = ci('web', 'web-01');

function rel(id: string, from: CiSummary, to: CiSummary, attributes: RelationshipRow['attributes'], confidence = 1): RelationshipRow {
  return { id, type: 'depends_on', from, to, attributes, source: { collectorId: 'adm', nodeId: 'reconciler', runId: 'r', confidence }, validFrom: '2026-11-05T00:00:00.000Z', validTo: null };
}

describe('observed traffic', () => {
  it('lists derived edges in the root direction, busiest first, and skips asserted ones', () => {
    const rows = observedTraffic(
      [
        rel('asserted', root, db, {}),
        rel('to-db', root, db, { derivedFrom: 'flows', protocol: 'tcp', ports: [5432], flows: 40, bytes: 2048, processes: ['postgres'], lastSeen: '2026-11-05T10:00:00.000Z', confidence: 0.9, ambiguous: false }),
        rel('from-web', web, root, { derivedFrom: 'flows', protocol: 'tcp', ports: [8443, 443], flows: 120, bytes: 1_048_576, processes: [], confidence: 0.6, ambiguous: true }),
      ],
      root.id,
    );
    expect(rows.map((r) => [r.id, r.direction, r.other.displayName, r.flows])).toEqual([
      ['from-web', 'from', 'web-01', 120],
      ['to-db', 'to', 'db-01', 40],
    ]);
    expect(rows[0]).toMatchObject({ ports: [8443, 443], processes: [], lastSeen: null, confidence: 0.6, ambiguous: true });
    expect(rows[1]).toMatchObject({ processes: ['postgres'], lastSeen: '2026-11-05T10:00:00.000Z', confidence: 0.9 });
    expect(isDerivedFromFlows(rel('x', root, db, { derivedFrom: 'flows' }))).toBe(true);
    expect(isDerivedFromFlows(rel('y', root, db, {}))).toBe(false);
  });

  it('falls back to the provenance confidence and formats bytes in binary units', () => {
    const [row] = observedTraffic([rel('r', root, db, { derivedFrom: 'flows', flows: 3 }, 0.75)], root.id);
    expect(row?.confidence).toBe(0.75);
    expect(formatBytes('en', 512)).toBe('512 B');
    expect(formatBytes('en', 2048)).toBe('2 KiB');
    expect(formatBytes('en', 32_959_722_744)).toBe('30.7 GiB');
  });
});
