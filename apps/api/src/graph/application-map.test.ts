// T-157 REQ-DEP-004 (ADR-031) — the application map's pure half: tiers follow the catalogue order with unknown tiers
// last; dependency edges are classified internal, outbound or inbound against the application's own components with
// the far end's application named; a derived edge reads its protocol, ports, flows and confidence from its evidence,
// an asserted edge keeps its provenance confidence; edges that do not touch the application are dropped.
import { describe, expect, it } from 'vitest';
import { classifyDependencies, groupTiers, orderTiers, type EdgeRow } from './application-map.js';

describe('application map', () => {
  it('orders tiers by the catalogue and groups components by name', () => {
    expect(orderTiers(['db', 'zeta', 'web', 'api', 'alpha', 'web'])).toEqual(['web', 'api', 'db', 'alpha', 'zeta']);
    const grouped = groupTiers([
      { id: '2', tier: 'api', name: 'b-api' },
      { id: '1', tier: 'api', name: 'a-api' },
      { id: '3', tier: 'web', name: 'web' },
    ]);
    expect(grouped.map((g) => [g.tier, g.components.map((c) => c.name)])).toEqual([
      ['web', ['web']],
      ['api', ['a-api', 'b-api']],
    ]);
  });

  it('classifies edges by direction and reads a derived edge from its evidence', () => {
    const edges: EdgeRow[] = [
      { id: 'e1', type: 'depends_on', fromId: 'web', toId: 'api', attributes: { derivedFrom: 'flows', protocol: 'tcp', ports: [8443], flows: 100, confidence: 0.85 }, confidence: 0.9 },
      { id: 'e2', type: 'depends_on', fromId: 'api', toId: 'sso-api', attributes: { derivedFrom: 'flows', protocol: 'tcp', ports: [8443], flows: 50, confidence: 0.85 }, confidence: 0.9 },
      { id: 'e3', type: 'backed_by', fromId: 'api', toId: 'ledger-db', attributes: {}, confidence: 0.95 },
      { id: 'e4', type: 'depends_on', fromId: 'cards-api', toId: 'api', attributes: { derivedFrom: 'flows', protocol: 'tcp', ports: [8443], flows: 7, confidence: 0.6, ambiguous: true }, confidence: 0.9 },
      { id: 'e5', type: 'depends_on', fromId: 'x', toId: 'y', attributes: {}, confidence: 1 },
    ];
    const out = classifyDependencies(edges, new Set(['web', 'api']), new Map([['sso-api', 'app-sso'], ['cards-api', 'app-cards']]));
    expect(out.map((d) => [d.id, d.direction, d.otherApplicationId])).toEqual([
      ['e1', 'internal', null],
      ['e2', 'outbound', 'app-sso'],
      ['e3', 'outbound', null],
      ['e4', 'inbound', 'app-cards'],
    ]);
    expect(out[0]).toMatchObject({ derived: true, protocol: 'tcp', ports: [8443], flows: 100, confidence: 0.85 });
    expect(out[2]).toMatchObject({ derived: false, protocol: null, ports: [], flows: null, confidence: 0.95 });
    expect(out[3]?.confidence).toBe(0.6);
  });
});
