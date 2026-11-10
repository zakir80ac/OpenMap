// REQ-IPAM-007 (ADR-069) — network circuits under inter-site links, as pure functions:
// - a carrier circuit's health is its own, taken down by a down hand-off port at either end;
// - a link that is not probed takes its health from the circuits it rides on (they are in series: one down is the link
//   down);
// - two links joining the same two sites share a risk when they have the same provider, the same physical route or a
//   carrier circuit in common: `path_diversity` raises the later of them (backup after primary, then by name);
// - a link down between two sites that had more than one path is lost redundancy: `redundancy_lost` raises the link.
import { LINK_SHARED_RISK_KINDS, OVERLAY_ROLE, riskKey, type LinkSharedRiskKind } from '@openmap/contracts';
import type { Health } from './propagate.js';
import type { Breach } from './readiness.js';

/** What the diversity and redundancy rules need of one link. */
export interface CircuitLink {
  ciId: string;
  name: string;
  fromSite: string | null;
  toSite: string | null;
  role: string | null;
  provider: string | null;
  pathRef: string | null;
  /** Carrier circuit CIs the link rides on. */
  circuitCiIds: readonly string[];
  diversePaths: number;
  health: Health;
}

/** A risk one link shares with another link between the same sites. */
export interface SharedRisk {
  kind: LinkSharedRiskKind;
  /** The shared provider or route as the other link records it, or the shared circuit's CI id. */
  value: string;
  otherCiId: string;
  otherName: string;
}

/** Roles in the order a pair is read: the primary first, so the backup is the one that is not diverse from it. */
const ROLE_ORDER: readonly string[] = ['primary', 'backup', OVERLAY_ROLE];

function roleRank(role: string | null): number {
  const i = role === null ? -1 : ROLE_ORDER.indexOf(role);
  return i === -1 ? ROLE_ORDER.length : i;
}

/** Links between the same two sites, in either direction; a link with an unknown end stands alone. */
export function sitePairKey(l: Pick<CircuitLink, 'ciId' | 'fromSite' | 'toSite'>): string {
  return l.fromSite === null || l.toSite === null
    ? 'link:' + l.ciId
    : [l.fromSite, l.toSite].sort().join('|');
}

function groups<T extends Pick<CircuitLink, 'ciId' | 'fromSite' | 'toSite'>>(links: readonly T[]): T[][] {
  const out = new Map<string, T[]>();
  for (const l of links) out.set(sitePairKey(l), [...(out.get(sitePairKey(l)) ?? []), l]);
  return [...out.values()];
}

function ordered(group: readonly CircuitLink[]): CircuitLink[] {
  return [...group].sort(
    (a, b) =>
      roleRank(a.role) - roleRank(b.role) || a.name.localeCompare(b.name) || a.ciId.localeCompare(b.ciId),
  );
}

/** What `a` shares with `b`, in LINK_SHARED_RISK_KINDS order. */
function shared(a: CircuitLink, b: CircuitLink): SharedRisk[] {
  const out: SharedRisk[] = [];
  const of = (kind: LinkSharedRiskKind, value: string): SharedRisk => ({
    kind,
    value,
    otherCiId: b.ciId,
    otherName: b.name,
  });
  for (const kind of LINK_SHARED_RISK_KINDS) {
    if (kind === 'provider') {
      const key = riskKey(a.provider);
      if (key !== null && key === riskKey(b.provider) && b.provider !== null)
        out.push(of(kind, b.provider.trim()));
    } else if (kind === 'path') {
      const key = riskKey(a.pathRef);
      if (key !== null && key === riskKey(b.pathRef) && b.pathRef !== null)
        out.push(of(kind, b.pathRef.trim()));
    } else {
      const theirs = new Set(b.circuitCiIds);
      for (const id of a.circuitCiIds) if (theirs.has(id)) out.push(of(kind, id));
    }
  }
  return out;
}

/**
 * Every link's shared risks with the other non-overlay links joining the same two sites, keyed by link CI id. Both
 * links of a pair list the risk; an overlay is never compared, because it rides another link by definition.
 */
export function sharedRisks(links: readonly CircuitLink[]): Map<string, SharedRisk[]> {
  const out = new Map<string, SharedRisk[]>();
  for (const group of groups(links.filter((l) => l.role !== OVERLAY_ROLE))) {
    for (const a of group) {
      const risks = group.filter((b) => b.ciId !== a.ciId).flatMap((b) => shared(a, b));
      if (risks.length > 0) out.set(a.ciId, risks);
    }
  }
  return out;
}

function riskText(r: SharedRisk, circuitName: (ciId: string) => string): string {
  if (r.kind === 'provider') return 'provider ' + r.value;
  if (r.kind === 'path') return 'route ' + r.value;
  return 'carrier circuit ' + circuitName(r.value);
}

/**
 * `path_diversity`: in each group of non-overlay links between the same two sites, read primary first, a link that
 * shares a provider, a route or a carrier circuit with a link read before it breaches. One breach per link, naming
 * everything it shares.
 */
export function pathDiversityBreaches(
  links: readonly CircuitLink[],
  circuitName: (ciId: string) => string,
): Breach[] {
  const out: Breach[] = [];
  for (const group of groups(links.filter((l) => l.role !== OVERLAY_ROLE))) {
    const seen: CircuitLink[] = [];
    for (const link of ordered(group)) {
      const risks = seen.flatMap((earlier) => shared(link, earlier));
      seen.push(link);
      if (risks.length === 0) continue;
      const withWhom = [...new Set(risks.map((r) => r.otherName))];
      out.push({
        rule: 'path_diversity',
        subjectCiId: link.ciId,
        detail:
          link.name +
          ' shares ' +
          risks.map((r) => riskText(r, circuitName)).join(', ') +
          ' with ' +
          withWhom.join(', ') +
          ': they are not diverse paths.',
      });
    }
  }
  return out;
}

/**
 * `redundancy_lost`: in each group of links between the same two sites that has more than one path (a link counts its
 * diverse paths), every link that is down breaches. A link that is not down counts as up, as in linkRedundancy.
 */
export function redundancyLostBreaches(links: readonly CircuitLink[]): Breach[] {
  const out: Breach[] = [];
  const paths = (l: CircuitLink): number => Math.max(1, l.diversePaths);
  for (const group of groups(links)) {
    const total = group.reduce((n, l) => n + paths(l), 0);
    if (total <= 1) continue;
    const up = group.filter((l) => l.health !== 'down').reduce((n, l) => n + paths(l), 0);
    const [first] = group;
    const ends =
      first?.fromSite !== null && first?.fromSite !== undefined && first.toSite !== null
        ? first.fromSite + '-' + first.toSite
        : (first?.name ?? '');
    for (const link of ordered(group)) {
      if (link.health !== 'down') continue;
      out.push({
        rule: 'redundancy_lost',
        subjectCiId: link.ciId,
        detail:
          link.name + ' is down; ' + ends + ' has ' + String(up) + ' of ' + String(total) + ' paths up.',
      });
    }
  }
  return out;
}

/** A carrier circuit's health: its own, taken down (or degraded) by its hand-off ports at either end. */
export function circuitHealth(own: Health, handOffs: readonly Health[]): Health {
  const all = [own, ...handOffs];
  if (all.includes('down')) return 'down';
  if (all.includes('degraded')) return 'degraded';
  return own;
}

/**
 * The health of a link that is not probed, from the circuits it rides on, which are in series (one down is the link
 * down, one degraded degrades it), all healthy is healthy, and otherwise nothing is known. Null when it rides on none.
 */
export function linkHealthFromCircuits(circuits: readonly Health[]): Health | null {
  if (circuits.length === 0) return null;
  if (circuits.includes('down')) return 'down';
  if (circuits.includes('degraded')) return 'degraded';
  return circuits.every((h) => h === 'healthy') ? 'healthy' : 'unknown';
}
