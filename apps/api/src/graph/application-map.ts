// REQ-DEP-004 (ADR-031) — the layered application map, the pure half: components are grouped into tiers in the
// catalogue's order (unknown tiers last, alphabetically), and every dependency edge touching a component of the
// application is classified as internal, outbound or inbound with the far end's application named, its evidence
// read from a derived edge's attributes (ADR-029). Deterministic: same rows, same map.
import { ADM, APPLICATION_MAP } from '@openmap/constants';

export interface ComponentRow {
  id: string;
  tier: string;
  name: string;
}

export interface EdgeRow {
  id: string;
  type: string;
  fromId: string;
  toId: string;
  attributes: Record<string, unknown>;
  confidence: number;
}

export type DependencyDirection = 'internal' | 'outbound' | 'inbound';

/** Listing order: what happens inside the application, then what it needs, then who needs it. */
const DIRECTION_ORDER: readonly DependencyDirection[] = ['internal', 'outbound', 'inbound'];

export interface ClassifiedDependency {
  id: string;
  type: string;
  fromId: string;
  toId: string;
  direction: DependencyDirection;
  /** The far end's application id when it is a component of one, else null. */
  otherApplicationId: string | null;
  derived: boolean;
  protocol: string | null;
  ports: number[];
  flows: number | null;
  confidence: number;
}

/** Tiers in catalogue order; tiers the catalogue does not name follow alphabetically. */
export function orderTiers(tiers: readonly string[]): string[] {
  const known: readonly string[] = APPLICATION_MAP.tierOrder;
  return [...new Set(tiers)].sort((a, b) => {
    const ia = known.indexOf(a);
    const ib = known.indexOf(b);
    if (ia >= 0 && ib >= 0) return ia - ib;
    if (ia >= 0) return -1;
    if (ib >= 0) return 1;
    return a.localeCompare(b);
  });
}

/** Components grouped by tier, tiers ordered, components by name within a tier. */
export function groupTiers<T extends ComponentRow>(components: readonly T[]): Array<{ tier: string; components: T[] }> {
  return orderTiers(components.map((c) => c.tier)).map((tier) => ({
    tier,
    components: components.filter((c) => c.tier === tier).sort((a, b) => a.name.localeCompare(b.name)),
  }));
}

function numbers(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((v): v is number => typeof v === 'number') : [];
}

/**
 * Classifies each edge against the application's own components: both ends inside is internal, only the source
 * inside is outbound, only the target inside is inbound; edges with neither end inside are dropped. A derived edge's
 * protocol, ports and flow count come from its evidence; an asserted one keeps its provenance confidence.
 */
export function classifyDependencies(
  edges: readonly EdgeRow[],
  ownComponentIds: ReadonlySet<string>,
  applicationOf: ReadonlyMap<string, string>,
): ClassifiedDependency[] {
  const out: ClassifiedDependency[] = [];
  for (const e of edges) {
    const fromInside = ownComponentIds.has(e.fromId);
    const toInside = ownComponentIds.has(e.toId);
    if (!fromInside && !toInside) continue;
    const direction: DependencyDirection = fromInside && toInside ? 'internal' : fromInside ? 'outbound' : 'inbound';
    const farId = direction === 'inbound' ? e.fromId : e.toId;
    const derived = e.attributes[ADM.derivedFromKey] === ADM.derivedFromFlows;
    const protocol = typeof e.attributes['protocol'] === 'string' ? e.attributes['protocol'] : null;
    const flows = typeof e.attributes['flows'] === 'number' ? e.attributes['flows'] : null;
    out.push({
      id: e.id,
      type: e.type,
      fromId: e.fromId,
      toId: e.toId,
      direction,
      otherApplicationId: direction === 'internal' ? null : (applicationOf.get(farId) ?? null),
      derived,
      protocol,
      ports: numbers(e.attributes['ports']),
      flows,
      confidence: derived && typeof e.attributes['confidence'] === 'number' ? e.attributes['confidence'] : e.confidence,
    });
  }
  const rank = (d: DependencyDirection): number => DIRECTION_ORDER.indexOf(d);
  return out.sort((a, b) => rank(a.direction) - rank(b.direction) || (b.flows ?? 0) - (a.flows ?? 0) || a.id.localeCompare(b.id));
}
