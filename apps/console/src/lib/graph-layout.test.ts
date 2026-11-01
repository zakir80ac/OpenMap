// T-060 REQ-UI-007 REQ-DEP-005 — lane layout: lanes follow CI_LAYERS order, hidden layers are bridged, sizes shrink with
// depth; the force layout is deterministic, pins the root and pulls neighbours closer than strangers; the impact closure
// of a node is its chain through the drawn graph.
import { DEPENDENCY_MAP } from '@openmap/constants';
import { CI_LAYERS, RELATIONSHIP_TYPES } from '@openmap/contracts';
import { layerColors, stateColors, text } from '@openmap/ui';
import { describe, expect, it } from 'vitest';
import {
  assignForcePositions,
  assignLanePositions,
  buildImpactGraph,
  forceLayoutAvailable,
  impactClosure,
  isLayoutMode,
  laneOrder,
  layoutPositions,
  nodeColor,
  nodeSize,
  normalisePath,
  predictedColor,
  relationshipColor,
  relationshipFamily,
  visiblePairs,
  type LayerVisibilityMap,
  type LayoutNode,
} from './graph-layout';
import type { ImpactResult } from './queries';

const allVisible = Object.fromEntries(CI_LAYERS.map((layer) => [layer, true])) as Record<
  (typeof CI_LAYERS)[number],
  boolean
>;

function ci(id: string, layer: (typeof CI_LAYERS)[number], type = 'host') {
  return { id, name: id, displayName: id.toUpperCase(), code: 'X-' + id.toUpperCase(), type, layer, health: 'healthy' as const };
}

const result: ImpactResult = {
  root: ci('db', 'databases', 'database'),
  durationMs: 184,
  nodes: [
    { ci: ci('app', 'applications', 'application'), depth: 1, predicted: 'degraded', path: ['db', 'app'] },
    { ci: ci('vm', 'virtualization', 'vm'), depth: 1, predicted: 'down', path: ['db', 'vm'] },
    { ci: ci('host', 'hardware'), depth: 2, predicted: 'down', path: ['db', 'vm', 'host'] },
    { ci: ci('rack', 'dc', 'rack'), depth: 3, predicted: 'at_risk', path: ['db', 'vm', 'host', 'rack'] },
  ],
  services: [
    {
      service: ci('svc', 'applications', 'business_service'),
      tier: 1,
      predicted: 'down',
      path: ['db', 'app', 'svc'],
      usersAffected: null,
      revenueAtRiskPerHour: null,
      slaBudgetRemainingMinutes: null,
      recovery: null,
    },
  ],
};

describe('normalisePath and visiblePairs', () => {
  it('guarantees the chain starts at the root and ends at the node', () => {
    expect(normalisePath('r', 'n', ['m'])).toEqual(['r', 'm', 'n']);
    expect(normalisePath('r', 'n', ['r', 'm', 'n'])).toEqual(['r', 'm', 'n']);
  });
  it('bridges across hidden ids and never pairs a node with itself', () => {
    const pairs = visiblePairs(['r', 'hidden', 'n', 'n'], new Set(['r', 'n']));
    expect(pairs).toEqual([{ source: 'r', target: 'n', bridged: true }]);
  });
});

describe('buildImpactGraph', () => {
  it('includes the root at depth 0 and every node and service path as edges', () => {
    const graph = buildImpactGraph(result, allVisible);
    expect(graph.nodes.map((n) => n.id).sort()).toEqual(['app', 'db', 'host', 'rack', 'vm']);
    expect(graph.nodes.find((n) => n.id === 'db')?.depth).toBe(0);
    const edge = graph.edges.find((e) => e.id === 'db→app');
    expect(edge?.predicted).toBe('degraded');
    expect(edge?.onServicePath).toBe(true);
    expect(graph.edges.find((e) => e.id === 'vm→host')?.onServicePath).toBe(false);
  });
  it('drops hidden layers and bridges their neighbours', () => {
    const visibility: LayerVisibilityMap = { ...allVisible, virtualization: false };
    const graph = buildImpactGraph(result, visibility);
    expect(graph.nodes.some((n) => n.layer === 'virtualization')).toBe(false);
    const bridged = graph.edges.find((e) => e.id === 'db→host');
    expect(bridged?.bridged).toBe(true);
    expect(graph.edges.some((e) => e.id === 'db→vm')).toBe(false);
  });
  it('always keeps the root even when its layer is hidden', () => {
    const graph = buildImpactGraph(result, { ...allVisible, databases: false });
    expect(graph.nodes.some((n) => n.id === 'db')).toBe(true);
  });
});

describe('assignLanePositions', () => {
  const nodes: LayoutNode[] = [
    { id: 'db', layer: 'databases', depth: 0, label: 'db' },
    { id: 'app', layer: 'applications', depth: 1, label: 'app' },
    { id: 'app2', layer: 'applications', depth: 1, label: 'aaa' },
    { id: 'rack', layer: 'dc', depth: 3, label: 'rack' },
  ];
  it('orders lanes by the contract layer order with y growing by laneHeight', () => {
    expect(laneOrder(nodes)).toEqual(['dc', 'databases', 'applications']);
    const out = assignLanePositions({ requestId: 1, rootId: 'db', mode: 'lane', nodes, edges: [] });
    expect(out.requestId).toBe(1);
    expect(out.lanes.map((l) => l.layer)).toEqual(['dc', 'databases', 'applications']);
    expect(out.positions['rack']?.y).toBe(0);
    expect(out.positions['db']?.y).toBe(DEPENDENCY_MAP.laneHeight);
    expect(out.positions['app']?.y).toBe(DEPENDENCY_MAP.laneHeight * 2);
  });
  it('centres each lane on x = 0 and spaces nodes by nodeSpacing in a stable order', () => {
    const out = assignLanePositions({ requestId: 2, rootId: 'db', mode: 'lane', nodes, edges: [] });
    expect(out.positions['db']?.x).toBe(0);
    const app = out.positions['app'];
    const app2 = out.positions['app2'];
    expect(app).toBeDefined();
    expect(app2).toBeDefined();
    expect(Math.abs((app?.x ?? 0) - (app2?.x ?? 0))).toBe(DEPENDENCY_MAP.nodeSpacing);
    expect((app?.x ?? 0) + (app2?.x ?? 0)).toBe(0);
    expect(app2?.x).toBeLessThan(app?.x ?? 0);
    expect(out.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe('visual encodings', () => {
  it('shrinks nodes with depth but not below the minimum', () => {
    expect(nodeSize(0)).toBe(DEPENDENCY_MAP.rootNodeSize);
    expect(nodeSize(1)).toBe(DEPENDENCY_MAP.rootNodeSize - DEPENDENCY_MAP.nodeSizeStep);
    expect(nodeSize(DEPENDENCY_MAP.rootNodeSize)).toBe(DEPENDENCY_MAP.minNodeSize);
  });
  it('colours nodes by layer and edges by predicted state', () => {
    expect(nodeColor({ layer: 'storage' })).toBe(layerColors.storage);
    expect(predictedColor('down')).toBe(stateColors.down);
    expect(predictedColor('unaffected')).toBe(text.muted);
  });
  it('gives every contract relationship type a family colour', () => {
    for (const type of RELATIONSHIP_TYPES) {
      expect(relationshipFamily[type]).toBeDefined();
      expect(relationshipColor(type)).toMatch(/^#/);
    }
    expect(relationshipColor('not-a-type')).toBe(text.muted);
  });
});

describe('force layout and layout modes', () => {
  const nodes: LayoutNode[] = [
    { id: 'db', layer: 'databases', depth: 0, label: 'db' },
    { id: 'app', layer: 'applications', depth: 1, label: 'app' },
    { id: 'vm', layer: 'virtualization', depth: 1, label: 'vm' },
    { id: 'host', layer: 'hardware', depth: 2, label: 'host' },
    { id: 'far', layer: 'dc', depth: 3, label: 'far' },
  ];
  const edges = [
    { source: 'db', target: 'app' },
    { source: 'db', target: 'vm' },
    { source: 'vm', target: 'host' },
  ];
  it('is deterministic, pins the root and keeps connected nodes closer than unconnected ones', () => {
    const a = assignForcePositions({ requestId: 1, rootId: 'db', mode: 'force', nodes, edges });
    const b = assignForcePositions({ requestId: 2, rootId: 'db', mode: 'force', nodes, edges });
    expect(a.positions).toEqual(b.positions);
    expect(a.lanes).toEqual([]);
    // The root keeps its lane seed: pinned, never moved by the forces.
    expect(a.positions['db']).toEqual(
      assignLanePositions({ requestId: 0, rootId: 'db', mode: 'lane', nodes, edges }).positions['db'],
    );
    const dist = (p: string, q: string): number =>
      Math.hypot(
        (a.positions[p]?.x ?? 0) - (a.positions[q]?.x ?? 0),
        (a.positions[p]?.y ?? 0) - (a.positions[q]?.y ?? 0),
      );
    expect(dist('vm', 'host')).toBeLessThan(dist('vm', 'far'));
    expect(dist('db', 'app')).toBeLessThan(dist('app', 'far'));
    const ids = Object.keys(a.positions).sort();
    expect(ids).toEqual(['app', 'db', 'far', 'host', 'vm']);
    for (const id of ids) {
      expect(Number.isFinite(a.positions[id]?.x)).toBe(true);
      expect(Number.isFinite(a.positions[id]?.y)).toBe(true);
    }
  });
  it('dispatches by mode and falls back to lanes above the force limit', () => {
    expect(isLayoutMode('force')).toBe(true);
    expect(isLayoutMode('spiral')).toBe(false);
    expect(forceLayoutAvailable(DEPENDENCY_MAP.forceMaxNodes)).toBe(true);
    expect(forceLayoutAvailable(DEPENDENCY_MAP.forceMaxNodes + 1)).toBe(false);
    expect(
      layoutPositions({ requestId: 3, rootId: 'db', mode: 'lane', nodes, edges }).lanes.length,
    ).toBeGreaterThan(0);
    expect(layoutPositions({ requestId: 4, rootId: 'db', mode: 'force', nodes, edges }).lanes).toEqual([]);
    const many: LayoutNode[] = Array.from({ length: DEPENDENCY_MAP.forceMaxNodes + 1 }, (_, i) => ({
      id: 'n' + String(i),
      layer: 'hardware',
      depth: 1,
      label: 'n' + String(i),
    }));
    expect(
      layoutPositions({ requestId: 5, rootId: 'n0', mode: 'force', nodes: many, edges: [] }).lanes.length,
    ).toBe(1);
  });
});

describe('impactClosure', () => {
  const graph = buildImpactGraph(result, allVisible);
  it('lights the node, what it reaches and what reaches it, and nothing else', () => {
    // Business services are listed in the side panel, not drawn, so the closure stops at the drawn nodes.
    expect([...impactClosure(graph, 'vm')].sort()).toEqual(['db', 'host', 'rack', 'vm']);
    expect([...impactClosure(graph, 'app')].sort()).toEqual(['app', 'db']);
    expect([...impactClosure(graph, 'db')].sort()).toEqual(['app', 'db', 'host', 'rack', 'vm']);
    expect([...impactClosure(graph, 'nowhere')]).toEqual(['nowhere']);
  });
});
