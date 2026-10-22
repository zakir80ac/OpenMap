// REQ-UI-007 REQ-DEP-003 REQ-DEP-005 — dependency map model and lane layout. Pure functions: an `impact` result
// becomes nodes and edges, hidden layers are bridged out of the paths, and nodes are placed in horizontal lanes
// (one per CI layer in CI_LAYERS order) so the same code runs on the main thread and in the layout Web Worker.
import { BSM, DEPENDENCY_MAP } from '@openmap/constants';
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
export function visiblePairs(chain: ReadonlyArray<string>, visible: ReadonlySet<string>): Array<{ source: string; target: string; bridged: boolean }> {
  const out: Array<{ source: string; target: string; bridged: boolean }> = [];
  let previous: string | undefined;
  let skipped = false;
  for (const id of chain) {
    if (!visible.has(id)) {
      if (previous !== undefined) skipped = true;
      continue;
    }
    if (previous !== undefined && previous !== id) out.push({ source: previous, target: id, bridged: skipped });
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

export interface LayoutRequest {
  requestId: number;
  rootId: string;
  nodes: LayoutNode[];
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

/** Node radius shrinks with distance from the root but never below the minimum. */
export function nodeSize(depth: number): number {
  return Math.max(DEPENDENCY_MAP.minNodeSize, DEPENDENCY_MAP.rootNodeSize - depth * DEPENDENCY_MAP.nodeSizeStep);
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
export const RELATIONSHIP_FAMILIES = ['dependency', 'placement', 'power', 'network', 'risk', 'commercial', 'data'] as const;
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
