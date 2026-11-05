// REQ-UI-007 REQ-DEP-003 REQ-DEP-005 — dependency map model and lane layout. Pure functions: an `impact` result
// becomes nodes and edges, hidden layers are bridged out of the paths, and nodes are placed in horizontal lanes
// (one per CI layer in CI_LAYERS order) so the same code runs on the main thread and in the layout Web Worker.
import { BSM, DEPENDENCY_MAP, GEOMETRY } from '@openmap/constants';
import { CI_LAYERS, type CiLayer, type RelationshipType } from '@openmap/contracts';
import { accents, layerColor, stateColor, text, type HexColor, type UiState } from '@openmap/ui';
import type { HealthState, ImpactResult, PredictedState } from './queries';

export interface MapNode {
  id: string;
  label: string;
  type: string;
  layer: CiLayer;
  health: HealthState;
  depth: number;
  predicted: PredictedState;
}

export interface MapEdge {
  /** `source→target`; stable across re-layouts so Sigma can diff. */
  id: string;
  source: string;
  target: string;
  /** Predicted state of the far (dependant) end; drives the base edge colour. */
  predicted: PredictedState;
  /** True when the pair is adjacent only because a hidden layer sits between them. */
  bridged: boolean;
  /** True when the edge lies on the path from the root to an affected service. */
  onServicePath: boolean;
}

export interface ImpactGraph {
  nodes: MapNode[];
  edges: MapEdge[];
}

export type LayerVisibilityMap = Readonly<Record<CiLayer, boolean>>;

/** Root-to-node chain guaranteed to start with the root id and end with the node id. */
export function normalisePath(rootId: string, nodeId: string, path: ReadonlyArray<string>): string[] {
  const chain = [...path];
  if (chain[0] !== rootId) chain.unshift(rootId);
  if (chain[chain.length - 1] !== nodeId) chain.push(nodeId);
  return chain;
}

/** Consecutive visible pairs of a chain; hidden ids are skipped and the pair across them is marked bridged. */
export function visiblePairs(
  chain: ReadonlyArray<string>,
  visible: ReadonlySet<string>,
): Array<{ source: string; target: string; bridged: boolean }> {
  const out: Array<{ source: string; target: string; bridged: boolean }> = [];
  let previous: string | undefined;
  let skipped = false;
  for (const id of chain) {
    if (!visible.has(id)) {
      if (previous !== undefined) skipped = true;
      continue;
    }
    if (previous !== undefined && previous !== id)
      out.push({ source: previous, target: id, bridged: skipped });
    previous = id;
    skipped = false;
  }
  return out;
}

/** The root is always shown; every other node follows its layer's visibility. */
export function buildImpactGraph(result: ImpactResult, visibility: LayerVisibilityMap): ImpactGraph {
  const root = result.root;
  const byId = new Map<string, MapNode>();
  byId.set(root.id, {
    id: root.id,
    label: root.displayName,
    type: root.type,
    layer: root.layer,
    health: root.health,
    depth: 0,
    predicted: 'down',
  });
  for (const node of result.nodes) {
    if (node.ci.id === root.id) continue;
    if (!visibility[node.ci.layer]) continue;
    const existing = byId.get(node.ci.id);
    if (existing !== undefined && existing.depth <= node.depth) continue;
    byId.set(node.ci.id, {
      id: node.ci.id,
      label: node.ci.displayName,
      type: node.ci.type,
      layer: node.ci.layer,
      health: node.ci.health,
      depth: node.depth,
      predicted: node.predicted,
    });
  }
  const visible = new Set(byId.keys());
  const edges = new Map<string, MapEdge>();
  const add = (pairs: ReturnType<typeof visiblePairs>, onServicePath: boolean): void => {
    for (const pair of pairs) {
      const id = pair.source + '→' + pair.target;
      const target = byId.get(pair.target);
      const current = edges.get(id);
      if (current === undefined) {
        edges.set(id, { id, ...pair, predicted: target?.predicted ?? 'unaffected', onServicePath });
      } else if (onServicePath && !current.onServicePath) {
        edges.set(id, { ...current, onServicePath: true });
      }
    }
  };
  for (const node of result.nodes) {
    if (node.ci.id === root.id) continue;
    add(visiblePairs(normalisePath(root.id, node.ci.id, node.path), visible), false);
  }
  for (const service of result.services) {
    add(visiblePairs(normalisePath(root.id, service.service.id, service.path), visible), true);
  }
  return { nodes: [...byId.values()], edges: [...edges.values()] };
}

export interface LayoutNode {
  id: string;
  layer: CiLayer;
  depth: number;
  label: string;
}

import { type LayoutMode } from './layout-mode';

export { LAYOUT_MODES, isLayoutMode, type LayoutMode } from './layout-mode';

/** The force layout is offered only while the pairwise iteration stays inside the interaction budget. */
export function forceLayoutAvailable(nodeCount: number): boolean {
  return nodeCount <= DEPENDENCY_MAP.forceMaxNodes;
}

export interface LayoutEdge {
  source: string;
  target: string;
}

export interface LayoutRequest {
  requestId: number;
  rootId: string;
  mode: LayoutMode;
  nodes: LayoutNode[];
  /** Edges drive the force layout's attraction; the lane layout ignores them. */
  edges: LayoutEdge[];
  /**
   * Where the force layout starts (REQ-DEP-001): from the lane positions (default, keeps the layers readable) or on a
   * circle around the root, for maps whose nodes share one layer and would otherwise stay on a single row.
   */
  seed?: 'lane' | 'circle';
}

export interface Position {
  x: number;
  y: number;
}

export interface Lane {
  layer: CiLayer;
  y: number;
  count: number;
}

export interface LayoutResponse {
  requestId: number;
  positions: Record<string, Position>;
  lanes: Lane[];
  durationMs: number;
}

/** Layers present in the request, in CI_LAYERS order, each given a lane; the lane index times laneHeight is its y. */
export function laneOrder(nodes: ReadonlyArray<LayoutNode>): CiLayer[] {
  const present = new Set(nodes.map((n) => n.layer));
  return CI_LAYERS.filter((layer) => present.has(layer));
}

/** Deterministic within-lane order: the root first, then by depth, then by label for a stable picture. */
export function compareInLane(a: LayoutNode, b: LayoutNode, rootId: string): number {
  if (a.id === rootId) return -1;
  if (b.id === rootId) return 1;
  if (a.depth !== b.depth) return a.depth - b.depth;
  return a.label.localeCompare(b.label) || a.id.localeCompare(b.id);
}

function now(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}

/**
 * Lane layout. Each lane is centred on x = 0 so the root sits visually above and below its dependants; nodes
 * within a lane are evenly spaced. O(n log n) from the per-lane sort, no iteration, so a 100k-node graph
 * lays out in well under the one-second impact budget.
 */
export function assignLanePositions(request: LayoutRequest): LayoutResponse {
  const started = now();
  const lanes = laneOrder(request.nodes);
  const laneIndex = new Map<CiLayer, number>(lanes.map((layer, index) => [layer, index]));
  const grouped = new Map<CiLayer, LayoutNode[]>();
  for (const node of request.nodes) {
    const list = grouped.get(node.layer);
    if (list === undefined) grouped.set(node.layer, [node]);
    else list.push(node);
  }
  const positions: Record<string, Position> = {};
  const laneSummaries: Lane[] = [];
  for (const layer of lanes) {
    const list = grouped.get(layer) ?? [];
    list.sort((a, b) => compareInLane(a, b, request.rootId));
    const y = (laneIndex.get(layer) ?? 0) * DEPENDENCY_MAP.laneHeight;
    const width = (list.length - 1) * DEPENDENCY_MAP.nodeSpacing;
    const start = -width / DEPENDENCY_MAP.laneCentreDivisor;
    list.forEach((node, index) => {
      positions[node.id] = { x: start + index * DEPENDENCY_MAP.nodeSpacing, y };
    });
    laneSummaries.push({ layer, y, count: list.length });
  }
  return { requestId: request.requestId, positions, lanes: laneSummaries, durationMs: now() - started };
}

/**
 * Force layout: Fruchterman-Reingold with a fixed iteration count and a cooling step, seeded from the lane layout so
 * the result is deterministic for a given graph (no randomness, no time dependence). Every pair repels, every edge
 * attracts, the root is pinned at the origin. Lanes are not reported: there are none in this mode.
 */
export function assignForcePositions(request: LayoutRequest): LayoutResponse {
  const started = now();
  const ids = request.nodes.map((n) => n.id);
  const index = new Map(ids.map((id, i) => [id, i]));
  const count = ids.length;
  const xs = new Float64Array(count);
  const ys = new Float64Array(count);
  if (request.seed === 'circle') {
    // The root at the centre, every other node on a circle in request order: deterministic and two-dimensional.
    const radius = DEPENDENCY_MAP.forceIdealDistance * Math.sqrt(count);
    const turn = Math.PI * GEOMETRY.halfDivisor;
    let placed = 0;
    ids.forEach((id, i) => {
      if (id === request.rootId) return;
      const angle = (turn * placed) / Math.max(1, count - 1);
      placed += 1;
      xs[i] = Math.cos(angle) * radius;
      ys[i] = Math.sin(angle) * radius;
    });
  } else {
    const seed = assignLanePositions(request);
    ids.forEach((id, i) => {
      const p = seed.positions[id];
      xs[i] = p?.x ?? 0;
      ys[i] = p?.y ?? 0;
    });
  }
  const edges: Array<[number, number]> = [];
  for (const edge of request.edges) {
    const a = index.get(edge.source);
    const b = index.get(edge.target);
    if (a !== undefined && b !== undefined && a !== b) edges.push([a, b]);
  }
  const k = DEPENDENCY_MAP.forceIdealDistance;
  const k2 = k * k;
  const rootIndex = index.get(request.rootId);
  const dx = new Float64Array(count);
  const dy = new Float64Array(count);
  let step = DEPENDENCY_MAP.forceInitialStep;
  for (let iteration = 0; iteration < DEPENDENCY_MAP.forceIterations; iteration += 1) {
    dx.fill(0);
    dy.fill(0);
    for (let i = 0; i < count; i += 1) {
      for (let j = i + 1; j < count; j += 1) {
        let vx = (xs[i] ?? 0) - (xs[j] ?? 0);
        let vy = (ys[i] ?? 0) - (ys[j] ?? 0);
        let distance = Math.hypot(vx, vy);
        if (distance < DEPENDENCY_MAP.forceMinDistance) {
          // Coincident nodes get a deterministic nudge along the index order.
          vx = DEPENDENCY_MAP.forceMinDistance;
          vy = 0;
          distance = DEPENDENCY_MAP.forceMinDistance;
        }
        const repulsion = k2 / distance;
        const ux = (vx / distance) * repulsion;
        const uy = (vy / distance) * repulsion;
        dx[i] = (dx[i] ?? 0) + ux;
        dy[i] = (dy[i] ?? 0) + uy;
        dx[j] = (dx[j] ?? 0) - ux;
        dy[j] = (dy[j] ?? 0) - uy;
      }
    }
    for (const [a, b] of edges) {
      const vx = (xs[a] ?? 0) - (xs[b] ?? 0);
      const vy = (ys[a] ?? 0) - (ys[b] ?? 0);
      const distance = Math.max(Math.hypot(vx, vy), DEPENDENCY_MAP.forceMinDistance);
      const attraction = (distance * distance) / k;
      const ux = (vx / distance) * attraction;
      const uy = (vy / distance) * attraction;
      dx[a] = (dx[a] ?? 0) - ux;
      dy[a] = (dy[a] ?? 0) - uy;
      dx[b] = (dx[b] ?? 0) + ux;
      dy[b] = (dy[b] ?? 0) + uy;
    }
    for (let i = 0; i < count; i += 1) {
      if (i === rootIndex) continue;
      const magnitude = Math.hypot(dx[i] ?? 0, dy[i] ?? 0);
      if (magnitude === 0) continue;
      const scale = Math.min(magnitude, step) / magnitude;
      xs[i] = (xs[i] ?? 0) + (dx[i] ?? 0) * scale;
      ys[i] = (ys[i] ?? 0) + (dy[i] ?? 0) * scale;
    }
    step *= DEPENDENCY_MAP.forceCooling;
  }
  const positions: Record<string, Position> = {};
  ids.forEach((id, i) => {
    positions[id] = { x: xs[i] ?? 0, y: ys[i] ?? 0 };
  });
  return { requestId: request.requestId, positions, lanes: [], durationMs: now() - started };
}

/** The layout a request asks for; the Web Worker and the main-thread fallback both call this. */
export function layoutPositions(request: LayoutRequest): LayoutResponse {
  return request.mode === 'force' && forceLayoutAvailable(request.nodes.length)
    ? assignForcePositions(request)
    : assignLanePositions(request);
}

/**
 * Blast radius of one node inside the drawn graph: the node, everything reachable from it along edge direction
 * (what it carries) and everything that reaches it (what it stands on), so the chain through the node stays lit
 * while the rest of the map dims.
 */
export function impactClosure(graph: Pick<ImpactGraph, 'edges'>, nodeId: string): Set<string> {
  const forward = new Map<string, string[]>();
  const backward = new Map<string, string[]>();
  for (const edge of graph.edges) {
    forward.set(edge.source, [...(forward.get(edge.source) ?? []), edge.target]);
    backward.set(edge.target, [...(backward.get(edge.target) ?? []), edge.source]);
  }
  const closure = new Set<string>([nodeId]);
  const walk = (adjacency: Map<string, string[]>): void => {
    const queue = [nodeId];
    const seen = new Set<string>([nodeId]);
    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined) break;
      for (const next of adjacency.get(current) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        closure.add(next);
        queue.push(next);
      }
    }
  };
  walk(forward);
  walk(backward);
  return closure;
}

/** Node radius shrinks with distance from the root but never below the minimum. */
export function nodeSize(depth: number): number {
  return Math.max(
    DEPENDENCY_MAP.minNodeSize,
    DEPENDENCY_MAP.rootNodeSize - depth * DEPENDENCY_MAP.nodeSizeStep,
  );
}

export function nodeColor(node: Pick<MapNode, 'layer'>): HexColor {
  return layerColor(node.layer);
}

/** Predicted impact states share the health palette; `unaffected` is drawn as muted text colour. */
export function predictedColor(state: PredictedState): HexColor {
  switch (state) {
    case 'down':
      return stateColor('down');
    case 'degraded':
      return stateColor('degraded');
    case 'at_risk':
      return stateColor('at_risk');
    case 'unaffected':
      return text.muted;
  }
}

/**
 * Relationship families and their accents. Every contract relationship type has a colour (compile-time complete),
 * so an edge whose type is known is drawn in its family's accent and the legend lists the families.
 */
export const RELATIONSHIP_FAMILIES = [
  'dependency',
  'placement',
  'power',
  'network',
  'risk',
  'commercial',
  'data',
] as const;
export type RelationshipFamily = (typeof RELATIONSHIP_FAMILIES)[number];

export const relationshipFamily = {
  depends_on: 'dependency',
  runs_on: 'dependency',
  hosted_on: 'dependency',
  part_of_service: 'dependency',
  backed_by: 'dependency',
  mounted_on: 'dependency',
  installed_on: 'dependency',
  contains: 'placement',
  member_of: 'placement',
  located_in: 'placement',
  connected_to: 'placement',
  cabled_to: 'placement',
  zoned_with: 'placement',
  presented_to: 'placement',
  powered_by: 'power',
  cooled_by: 'power',
  uses_ip: 'network',
  in_subnet: 'network',
  in_vlan: 'network',
  resolves_to: 'network',
  leased_to: 'network',
  communicates_with: 'network',
  affected_by: 'risk',
  secured_by: 'risk',
  licensed_by: 'commercial',
  billed_to: 'commercial',
  covered_by: 'commercial',
  supported_by: 'commercial',
  owns: 'commercial',
  manages: 'commercial',
  assigned_to: 'commercial',
  spare_for: 'commercial',
  replicates_to: 'data',
} as const satisfies Record<RelationshipType, RelationshipFamily>;

export const relationshipFamilyColor = {
  dependency: accents.cyan,
  placement: accents.steel,
  power: accents.amber,
  network: accents.sky,
  risk: accents.rose,
  commercial: accents.violetLight,
  data: accents.orange,
} as const satisfies Record<RelationshipFamily, HexColor>;

export function isRelationshipType(value: string): value is RelationshipType {
  return Object.hasOwn(relationshipFamily, value);
}

export function relationshipColor(type: string): HexColor {
  return isRelationshipType(type) ? relationshipFamilyColor[relationshipFamily[type]] : text.muted;
}

/** Predicted states map onto the UI state palette; an unaffected service is drawn as healthy. */
export function predictedUiState(state: PredictedState): UiState {
  return state === 'unaffected' ? 'healthy' : state;
}

/** Sort key for predicted states, worst first, from the shared BSM order. */
export function predictedRank(state: PredictedState): number {
  return BSM.predictedOrder.indexOf(state);
}
