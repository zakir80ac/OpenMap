// T-494 REQ-UI-027 — the fleet's paging rules over a snapshot: category and text filters narrow the rows and the
// health counts, the health filter narrows only the rows, measures sort highest first with no value last, health
// sorts worst first, and every sort key's order is ready when the snapshot is built.
import { describe, expect, it } from 'vitest';
import { TELEMETRY } from '@openmap/constants';
import { pageFleet, prepareSnapshot, textMatches, type FleetRowView, type FleetSnapshot } from './telemetry.service.js';

type Row = Omit<FleetRowView, 'rank'>;

function row(name: string, over: Partial<Row> = {}): Row {
  const base: Row = {
    ciId: name,
    name,
    layer: 'hardware',
    site: 'RYD',
    address: name + '.bank.local',
    health: 'healthy',
    cpu: null,
    memory: null,
    iops: null,
    throughput: null,
    apdex: null,
    observedAt: null,
    search: '',
  };
  const r = { ...base, ...over };
  return { ...r, search: [r.name, r.address ?? '', r.site ?? ''].join(' ').toLowerCase() };
}

const rows = [
  row('esx-02', { cpu: 41, health: 'degraded' }),
  row('esx-01', { cpu: 88 }),
  row('vm-app-01', { layer: 'virtualization', cpu: 12, health: 'down' }),
  row('core-sw-01', { layer: 'network_security', throughput: 6.3, site: 'JED', address: '10.31.0.1' }),
  row('array-01', { layer: 'storage', iops: 48_000, health: 'unknown' }),
  row('esx-03'),
];

function snapshot(): FleetSnapshot {
  return prepareSnapshot(rows, new Date('2026-11-08T06:00:00.000Z'));
}

const all = { layers: null, health: null, text: null };

describe('telemetry fleet paging', () => {
  it('sorts a measure highest first, rows without one last by name', () => {
    const page = pageFleet(snapshot(), all, 'cpu', TELEMETRY.defaultPageSize, 0);
    expect(page.items.map((r) => r.name)).toEqual(['esx-01', 'esx-02', 'vm-app-01', 'array-01', 'core-sw-01', 'esx-03']);
    expect(page).toMatchObject({ total: 6, healthy: 3, degraded: 1, down: 1, unknown: 1, asOf: new Date('2026-11-08T06:00:00.000Z') });
  });

  it('sorts health worst first and counts health before the health filter narrows the rows', () => {
    expect(pageFleet(snapshot(), all, 'health', TELEMETRY.defaultPageSize, 0).items.map((r) => r.health)).toEqual(['down', 'degraded', 'unknown', 'healthy', 'healthy', 'healthy']);
    const page = pageFleet(snapshot(), { layers: ['hardware', 'virtualization'], health: ['down', 'degraded'], text: null }, 'name', TELEMETRY.defaultPageSize, 0);
    expect(page.items.map((r) => r.name)).toEqual(['esx-02', 'vm-app-01']);
    expect(page).toMatchObject({ total: 2, healthy: 2, degraded: 1, down: 1, unknown: 0 });
  });

  it('matches text on the name, address or site, and pages with offset and first', () => {
    expect(pageFleet(snapshot(), { ...all, text: 'JED' }, 'name', TELEMETRY.defaultPageSize, 0).items.map((r) => r.name)).toEqual(['core-sw-01']);
    expect(pageFleet(snapshot(), { ...all, text: '10.31' }, 'name', TELEMETRY.defaultPageSize, 0).total).toBe(1);
    const page = pageFleet(snapshot(), all, 'name', 2, 2);
    expect(page.items.map((r) => r.name)).toEqual(['esx-01', 'esx-02']);
    expect(page.total).toBe(6);
  });

  it('orders every sort key when the snapshot is built and caps the page size', () => {
    const s = snapshot();
    expect([...s.sorted.keys()].sort()).toEqual(['apdex', 'cpu', 'health', 'iops', 'memory', 'name', 'throughput']);
    expect(s.sorted.get('iops')?.[0]?.name).toBe('array-01');
    expect(s.sorted.get('name')?.map((r) => r.rank)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(pageFleet(s, all, 'name', TELEMETRY.maxPageSize * 2, 0).items.length).toBeLessThanOrEqual(TELEMETRY.maxPageSize);
  });

  it('finds text matches by rank through the joined search string, each row once', () => {
    const s = snapshot();
    const names = (marks: Uint8Array) => s.rows.filter((r) => marks[r.rank] === 1).map((r) => r.name);
    expect(names(textMatches(s, 'esx'))).toEqual(['esx-01', 'esx-02', 'esx-03']);
    // "ryd" appears in five rows' site; each row is marked once however often it matches.
    expect(names(textMatches(s, 'ryd'))).toHaveLength(5);
    expect(names(textMatches(s, 'bank.local ryd'))).toHaveLength(5);
    expect(names(textMatches(s, 'nowhere'))).toEqual([]);
  });

  it('reads a one-category page from that category order, the same rows the general scan finds', () => {
    const s = snapshot();
    const one = pageFleet(s, { ...all, layers: ['hardware'] }, 'cpu', 2, 1);
    const scanned = pageFleet({ ...s, sortedByLayer: new Map() }, { ...all, layers: ['hardware', 'hardware'] }, 'cpu', 2, 1);
    expect(one.items.map((r) => r.name)).toEqual(['esx-02', 'esx-03']);
    expect(one.items.map((r) => r.name)).toEqual(scanned.items.map((r) => r.name));
    expect(one).toMatchObject({ total: 3, healthy: 2, degraded: 1 });
  });
});
