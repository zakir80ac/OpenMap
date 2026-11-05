// T-142 REQ-AI-007 — `hasContent`: an empty answer is one exact sentence and is never handed to the model to reword.
import { describe, expect, it } from 'vitest';
import { hasContent } from './compose.js';
import type { Summary } from './types.js';

const root = { ciId: 'h1', name: 'ledger-db' };

describe('hasContent', () => {
  it('is false for every empty summary kind and for the catalogue answers', () => {
    const empty: Summary[] = [
      { kind: 'count', type: 'host', count: 0, filters: [], health: null },
      {
        kind: 'groups',
        type: 'host',
        dimension: { kind: 'type', type: 'site' },
        groups: [],
        total: 0,
        filters: [],
        unit: '',
      },
      {
        kind: 'aggregate',
        type: 'host',
        family: 'memory',
        key: 'memoryGb',
        aggregate: 'avg',
        value: 0,
        unit: 'GB',
        count: 0,
        filters: [],
      },
      {
        kind: 'density',
        type: 'vm',
        counterpart: 'hypervisor',
        relationship: 'hosted_on',
        avg: 0,
        max: 0,
        groups: 0,
        total: 0,
        filters: [],
      },
      {
        kind: 'measurement',
        metric: 'dcim.power.watts',
        type: 'pdu',
        aggregate: 'avg',
        value: null,
        unit: 'W',
        count: 0,
        asOf: null,
        ranked: [],
        filters: [],
      },
      {
        kind: 'availability',
        granularity: 'month',
        back: 0,
        periodStart: '',
        lines: [],
        estatePercent: null,
        belowTarget: 0,
        downtimeMinutes: 0,
      },
      { kind: 'incidents', open: true, lines: [], scopeName: null },
      { kind: 'impact', root, direction: 'upstream', services: [], down: 0, degraded: 0, nodes: 0 },
      { kind: 'history', ci: root, versions: 1, latestAt: '2026-10-01T00:00:00.000Z', changedKeys: [] },
      { kind: 'graph', rows: [], truncated: false },
      { kind: 'howto', topic: 'ipam' },
      { kind: 'unresolvedFilter', value: 'atlantis' },
    ];
    for (const s of empty) expect(hasContent(s), s.kind).toBe(false);
  });
  it('is true once a summary carries a figure, a line or a row', () => {
    expect(hasContent({ kind: 'count', type: 'host', count: 1, filters: [], health: null })).toBe(true);
    expect(
      hasContent({
        kind: 'impact',
        root,
        direction: 'upstream',
        services: [{ ciId: 's', name: 'Payments', predicted: 'down' }],
        down: 1,
        degraded: 0,
        nodes: 3,
      }),
    ).toBe(true);
    expect(
      hasContent({
        kind: 'history',
        ci: root,
        versions: 2,
        latestAt: '2026-10-01T00:00:00.000Z',
        changedKeys: ['memoryGb'],
      }),
    ).toBe(true);
    expect(hasContent({ kind: 'graph', rows: [{ name: 'a' }], truncated: false })).toBe(true);
  });
});
