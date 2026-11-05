// T-153 REQ-DEP-001 (ADR-030) — topology folding offline: neighbour links seen from both ends become one link with
// every interface pair, the slowest speed and the protocols and media; host cabling and subnet memberships stay
// their own kinds; self-links are dropped; the node cap keeps the busiest nodes and drops links that leave the cap.
import { describe, expect, it } from 'vitest';
import { aggregateLinks, buildTopology, type RawLink } from './topology.js';

function link(fromId: string, toId: string, kind: RawLink['kind'], port: string, speedMbps: number | null = 10_000, protocol: string | null = 'lldp'): RawLink {
  return { fromId, toId, kind, port, protocol, media: kind === 'subnet' ? null : '100GBASE-SR4', speedMbps };
}

describe('network topology', () => {
  it('folds both directions of a neighbour link into one, keeping every interface pair and the slowest speed', () => {
    const links = aggregateLinks([
      link('core-01', 'dist-01', 'neighbour', 'Ethernet1/1 ↔ Ethernet49/1', 100_000),
      link('dist-01', 'core-01', 'neighbour', 'Ethernet49/1 ↔ Ethernet1/1', 100_000),
      link('core-01', 'dist-01', 'neighbour', 'Ethernet1/2 ↔ Ethernet50/1', 40_000, 'cdp'),
      link('core-01', 'core-01', 'neighbour', 'loop'),
    ]);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      fromId: 'core-01',
      toId: 'dist-01',
      kind: 'neighbour',
      count: 3,
      ports: ['Ethernet1/1 ↔ Ethernet49/1', 'Ethernet1/2 ↔ Ethernet50/1', 'Ethernet49/1 ↔ Ethernet1/1'],
      protocols: ['cdp', 'lldp'],
      media: ['100GBASE-SR4'],
      speedMbps: 40_000,
    });
  });

  it('keeps host cabling and subnet membership as their own kinds and counts degrees', () => {
    const map = buildTopology([
      link('core-01', 'dist-01', 'neighbour', 'a ↔ b'),
      link('srv-01', 'dist-01', 'host', 'eno1 → Ethernet1/11', 10_000, null),
      link('srv-01', 'dist-01', 'host', 'eno2 → Ethernet1/12', 10_000, null),
      link('core-01', 'net-10-0-0-0', 'subnet', '10.0.0.1', null, null),
    ]);
    expect(map.truncated).toBe(false);
    expect(map.links.map((l) => [l.kind, l.count])).toEqual(
      expect.arrayContaining([
        ['neighbour', 1],
        ['host', 2],
        ['subnet', 1],
      ]),
    );
    expect(map.degree.get('dist-01')).toBe(2);
    expect(map.degree.get('core-01')).toBe(2);
    expect(map.nodeIds[0]).toBe('core-01');
  });

  it('caps the map at the busiest nodes and says so', () => {
    const raw: RawLink[] = [
      link('hub', 'a', 'neighbour', '1'),
      link('hub', 'b', 'neighbour', '2'),
      link('hub', 'c', 'neighbour', '3'),
      link('a', 'b', 'neighbour', '4'),
      link('x', 'y', 'neighbour', '5'),
    ];
    const map = buildTopology(raw, 3);
    expect(map.truncated).toBe(true);
    expect(map.nodeIds).toEqual(['hub', 'a', 'b']);
    expect(map.links.every((l) => map.nodeIds.includes(l.fromId) && map.nodeIds.includes(l.toId))).toBe(true);
    expect(buildTopology(raw)).toMatchObject({ truncated: false });
  });
});
