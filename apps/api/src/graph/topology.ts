// REQ-DEP-001 (ADR-030) — network topology, the pure half: raw edges read from Postgres (neighbour links between
// interfaces with their owning devices, host cabling to device ports, device addresses in subnets) are folded into
// one link per node pair carrying the interface pairs, protocols, media and the slowest speed, then capped to the
// busiest nodes so the map stays interactive. Deterministic: same rows, same map.
import { TOPOLOGY } from '@openmap/constants';

export type TopologyLayer = (typeof TOPOLOGY.layers)[number];
export type LinkKind = 'neighbour' | 'host' | 'subnet';

/** One observed edge between two map nodes, before aggregation. */
export interface RawLink {
  fromId: string;
  toId: string;
  kind: LinkKind;
  /** "Ethernet1/1 ↔ Ethernet1/2", "eno1 → Ethernet1/11", or the address for a subnet membership. */
  port: string;
  protocol: string | null;
  media: string | null;
  speedMbps: number | null;
}

export interface AggregatedLink {
  id: string;
  fromId: string;
  toId: string;
  kind: LinkKind;
  count: number;
  ports: string[];
  protocols: string[];
  media: string[];
  speedMbps: number | null;
}

export interface TopologyMap {
  nodeIds: string[];
  degree: Map<string, number>;
  links: AggregatedLink[];
  truncated: boolean;
}

/** An undirected pair key: neighbour links are reported once whichever end the collector saw first. */
function pairKey(a: string, b: string, kind: LinkKind): string {
  return (a < b ? a + '\u0000' + b : b + '\u0000' + a) + '\u0000' + kind;
}

function pushUnique(list: string[], value: string | null): void {
  if (value !== null && value !== '' && !list.includes(value)) list.push(value);
}

/** Folds raw edges into one link per node pair and kind; self-links are dropped. */
export function aggregateLinks(raw: readonly RawLink[]): AggregatedLink[] {
  const byKey = new Map<string, AggregatedLink>();
  for (const r of raw) {
    if (r.fromId === r.toId) continue;
    const k = pairKey(r.fromId, r.toId, r.kind);
    const [fromId, toId] = r.kind === 'neighbour' && r.toId < r.fromId ? [r.toId, r.fromId] : [r.fromId, r.toId];
    let link = byKey.get(k);
    if (link === undefined) {
      link = { id: k.replaceAll('\u0000', ':'), fromId, toId, kind: r.kind, count: 0, ports: [], protocols: [], media: [], speedMbps: null };
      byKey.set(k, link);
    }
    link.count += 1;
    pushUnique(link.ports, r.port);
    pushUnique(link.protocols, r.protocol);
    pushUnique(link.media, r.media);
    if (r.speedMbps !== null && r.speedMbps > 0) link.speedMbps = link.speedMbps === null ? r.speedMbps : Math.min(link.speedMbps, r.speedMbps);
  }
  const links = [...byKey.values()];
  for (const l of links) {
    l.ports.sort();
    l.protocols.sort();
    l.media.sort();
  }
  return links.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * The map: every node with a link, capped at `maxNodes` by degree (busiest first, then id) so a large estate keeps
 * its backbone; links whose ends fell outside the cap are dropped and the map says it was truncated.
 */
export function buildTopology(raw: readonly RawLink[], maxNodes: number = TOPOLOGY.maxNodes): TopologyMap {
  const links = aggregateLinks(raw);
  const degree = new Map<string, number>();
  for (const l of links) {
    degree.set(l.fromId, (degree.get(l.fromId) ?? 0) + 1);
    degree.set(l.toId, (degree.get(l.toId) ?? 0) + 1);
  }
  const ranked = [...degree.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([id]) => id);
  const truncated = ranked.length > maxNodes;
  const kept = new Set(ranked.slice(0, maxNodes));
  const keptLinks = links.filter((l) => kept.has(l.fromId) && kept.has(l.toId));
  const keptDegree = new Map<string, number>();
  for (const l of keptLinks) {
    keptDegree.set(l.fromId, (keptDegree.get(l.fromId) ?? 0) + 1);
    keptDegree.set(l.toId, (keptDegree.get(l.toId) ?? 0) + 1);
  }
  const nodeIds = ranked.filter((id) => keptDegree.has(id));
  return { nodeIds, degree: keptDegree, links: keptLinks, truncated };
}
