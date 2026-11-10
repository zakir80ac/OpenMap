// T-590 REQ-IPAM-007 (ADR-069) — network circuit rules: shared risks between links joining the same sites (provider,
// route, carrier circuit; case and space ignored; overlays never compared), `path_diversity` raising the later link of
// a pair, `redundancy_lost` raising a down link only where there was more than one path, and a link's health from the
// carrier circuits it rides on, each taken down by a down hand-off port.
import { describe, expect, it } from 'vitest';
import {
  circuitHealth,
  linkHealthFromCircuits,
  pathDiversityBreaches,
  redundancyLostBreaches,
  sharedRisks,
  sitePairKey,
  type CircuitLink,
} from './circuits.js';

const link = (
  ciId: string,
  from: string | null,
  to: string | null,
  over: Partial<CircuitLink> = {},
): CircuitLink => ({
  ciId,
  name: ciId,
  fromSite: from,
  toSite: to,
  role: 'primary',
  provider: null,
  pathRef: null,
  circuitCiIds: [],
  diversePaths: 1,
  health: 'healthy',
  ...over,
});
const name = (id: string): string => 'circuit ' + id;

describe('sitePairKey', () => {
  it('joins the two ends in either direction and leaves a link with an unknown end alone', () => {
    expect(sitePairKey(link('a', 'RYD', 'JED'))).toBe(sitePairKey(link('b', 'JED', 'RYD')));
    expect(sitePairKey(link('a', 'RYD', null))).not.toBe(sitePairKey(link('b', 'RYD', null)));
  });
});

describe('sharedRisks', () => {
  it('finds a shared provider, route and carrier circuit, ignoring case and space', () => {
    const fibre = link('fibre', 'RYD', 'JED', {
      provider: 'stc',
      pathRef: 'Duct-7',
      circuitCiIds: ['c1', 'c2'],
    });
    const mpls = link('mpls', 'JED', 'RYD', {
      role: 'backup',
      provider: ' STC ',
      pathRef: 'duct-7 ',
      circuitCiIds: ['c2'],
    });
    const risks = sharedRisks([fibre, mpls]);
    expect(risks.get('mpls')?.map((r) => [r.kind, r.value, r.otherCiId])).toEqual([
      ['provider', 'stc', 'fibre'],
      ['path', 'Duct-7', 'fibre'],
      ['circuit', 'c2', 'fibre'],
    ]);
    expect(risks.get('fibre')?.map((r) => r.kind)).toEqual(['provider', 'path', 'circuit']);
  });
  it('finds nothing between diverse links, links of other site pairs, or an overlay', () => {
    const fibre = link('fibre', 'RYD', 'JED', { provider: 'stc', pathRef: 'north' });
    const mpls = link('mpls', 'RYD', 'JED', { role: 'backup', provider: 'Mobily', pathRef: 'south' });
    const other = link('other', 'RYD', 'DMM', { provider: 'stc', pathRef: 'north' });
    const overlay = link('vpn', 'RYD', 'JED', { role: 'overlay', provider: 'stc', pathRef: 'north' });
    expect(sharedRisks([fibre, mpls, other, overlay]).size).toBe(0);
  });
});

describe('pathDiversityBreaches', () => {
  it('raises the backup, not the primary, naming what it shares and with whom', () => {
    const backup = link('RYD-JED MPLS', 'RYD', 'JED', {
      role: 'backup',
      provider: 'stc',
      circuitCiIds: ['c9'],
    });
    const primary = link('RYD-JED fibre', 'RYD', 'JED', { provider: 'stc', circuitCiIds: ['c9'] });
    const breaches = pathDiversityBreaches([backup, primary], name);
    expect(breaches).toEqual([
      {
        rule: 'path_diversity',
        subjectCiId: 'RYD-JED MPLS',
        detail:
          'RYD-JED MPLS shares provider stc, carrier circuit circuit c9 with RYD-JED fibre: they are not diverse paths.',
      },
    ]);
  });
  it('raises each later link of three that shares with an earlier one, once', () => {
    const a = link('a', 'RYD', 'JED', { pathRef: 'duct' });
    const b = link('b', 'RYD', 'JED', { pathRef: 'duct' });
    const c = link('c', 'RYD', 'JED', { pathRef: 'duct', provider: 'x' });
    expect(pathDiversityBreaches([c, b, a], name).map((x) => x.subjectCiId)).toEqual(['b', 'c']);
  });
  it('raises nothing when the links are diverse', () => {
    expect(
      pathDiversityBreaches(
        [link('a', 'RYD', 'JED', { provider: 'stc' }), link('b', 'RYD', 'JED', { provider: 'Mobily' })],
        name,
      ),
    ).toEqual([]);
  });
});

describe('redundancyLostBreaches', () => {
  it('raises a down link where the sites had more than one path, counting the paths left up', () => {
    const down = link('fibre', 'RYD', 'JED', { health: 'down' });
    const up = link('mpls', 'JED', 'RYD', { role: 'backup', diversePaths: 2 });
    expect(redundancyLostBreaches([down, up])).toEqual([
      {
        rule: 'redundancy_lost',
        subjectCiId: 'fibre',
        detail: 'fibre is down; RYD-JED has 2 of 3 paths up.',
      },
    ]);
  });
  it('raises every down link when the pair has lost all paths', () => {
    const breaches = redundancyLostBreaches([
      link('a', 'RYD', 'JED', { health: 'down' }),
      link('b', 'RYD', 'JED', { health: 'down', role: 'backup' }),
    ]);
    expect(breaches.map((b) => [b.subjectCiId, b.detail])).toEqual([
      ['a', 'a is down; RYD-JED has 0 of 2 paths up.'],
      ['b', 'b is down; RYD-JED has 0 of 2 paths up.'],
    ]);
  });
  it('raises nothing for a single path, or when nothing is down', () => {
    expect(redundancyLostBreaches([link('only', 'HQ', 'RYD', { health: 'down' })])).toEqual([]);
    expect(
      redundancyLostBreaches([
        link('a', 'RYD', 'JED', { health: 'unknown' }),
        link('b', 'RYD', 'JED', { health: 'degraded' }),
      ]),
    ).toEqual([]);
  });
  it('counts a dual-path link as redundant on its own', () => {
    expect(
      redundancyLostBreaches([link('dual', 'RYD', 'JED', { health: 'down', diversePaths: 2 })]).map(
        (b) => b.subjectCiId,
      ),
    ).toEqual(['dual']);
  });
});

describe('circuit health', () => {
  it('takes a circuit down by a down hand-off port, degraded by a degraded one', () => {
    expect(circuitHealth('healthy', ['healthy', 'down'])).toBe('down');
    expect(circuitHealth('healthy', ['degraded'])).toBe('degraded');
    expect(circuitHealth('down', [])).toBe('down');
    expect(circuitHealth('healthy', ['unknown'])).toBe('healthy');
    expect(circuitHealth('unknown', [])).toBe('unknown');
  });
  it('gives a link the worst of the circuits it rides on, in series', () => {
    expect(linkHealthFromCircuits([])).toBeNull();
    expect(linkHealthFromCircuits(['healthy', 'healthy'])).toBe('healthy');
    expect(linkHealthFromCircuits(['healthy', 'down'])).toBe('down');
    expect(linkHealthFromCircuits(['degraded', 'healthy'])).toBe('degraded');
    expect(linkHealthFromCircuits(['healthy', 'unknown'])).toBe('unknown');
  });
});
