// REQ-DEP-001 (ADR-030) — a network topology as the map's graph: devices, hosts and subnets become nodes (sized by
// kind: network gear large, endpoints small), links become edges coloured by the relationship family they stand for
// (a neighbour link is connectivity, host cabling is placement, a subnet membership is addressing). A plain module so
// the view test and the view share one reading.
import { TOPOLOGY } from '@openmap/constants';
import type { RelationshipType } from '@openmap/contracts';
import type { ImpactGraph, MapEdge, MapNode } from '@/lib/graph-layout';
import type { NetworkTopology, TopologyLink, TopologyLinkKind } from '@/lib/topology-queries';

const DEVICE_TYPES: ReadonlySet<string> = new Set(TOPOLOGY.deviceTypes);

/** The relationship each link kind stands for, so the edge takes that family's colour. */
export const LINK_RELATIONSHIP: Record<TopologyLinkKind, RelationshipType> = {
  neighbour: 'connected_to',
  host: 'cabled_to',
  subnet: 'in_subnet',
};

export function edgeId(link: Pick<TopologyLink, 'from' | 'to'>): string {
  return link.from.id + '→' + link.to.id;
}

export function topologyGraph(topology: NetworkTopology): { graph: ImpactGraph; edgeTypes: Map<string, string> } {
  const nodes: MapNode[] = topology.nodes.map(({ ci }) => ({
    id: ci.id,
    label: ci.displayName,
    type: ci.type,
    layer: ci.layer,
    health: ci.health,
    depth: DEVICE_TYPES.has(ci.type) ? TOPOLOGY.deviceDepth : TOPOLOGY.endpointDepth,
    predicted: 'unaffected',
  }));
  const edges: MapEdge[] = topology.links.map((link) => ({
    id: edgeId(link),
    source: link.from.id,
    target: link.to.id,
    predicted: 'unaffected',
    bridged: false,
    onServicePath: false,
  }));
  const edgeTypes = new Map<string, string>();
  for (const link of topology.links) {
    edgeTypes.set(link.from.id + '→' + link.to.id, LINK_RELATIONSHIP[link.kind]);
    edgeTypes.set(link.to.id + '→' + link.from.id, LINK_RELATIONSHIP[link.kind]);
  }
  return { graph: { nodes, edges }, edgeTypes };
}

/** The links touching a node, busiest first, with the far end. */
export function linksOf(topology: NetworkTopology, nodeId: string): Array<TopologyLink & { other: TopologyLink['from'] }> {
  return topology.links
    .filter((l) => l.from.id === nodeId || l.to.id === nodeId)
    .map((l) => ({ ...l, other: l.from.id === nodeId ? l.to : l.from }))
    .sort((a, b) => b.count - a.count || a.other.displayName.localeCompare(b.other.displayName));
}
