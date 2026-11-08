// REQ-BSM-007 (ADR-025) — link health from probe samples and the HA / DR readiness rules, as pure functions:
// - a link is down when its last probe found it unreachable, degraded when it lost too many probes or ran slower than
//   committed, unknown when no probe is recent (or it names no probe target), healthy otherwise;
// - diverse_paths: a criticality-1 site needs READINESS.minDiversePaths healthy paths (a link counts its diversePaths);
// - dr_reachable: every DR site must be reachable from a primary site over healthy links;
// - replication_healthy: every replication link must be healthy.
// REQ-UI-026: the redundancy state of the links joining two sites (linkRedundancy).
import { READINESS } from '@openmap/constants';
import type { LinkRedundancy, ReadinessRule, SiteDrRole } from '@openmap/contracts';
import type { Health } from './propagate.js';

export interface LatestSample {
  value: number;
  /** Epoch milliseconds. */
  at: number;
}

export interface LinkSnapshot {
  ciId: string;
  name: string;
  fromSite: string | null;
  toSite: string | null;
  replication: boolean;
  diversePaths: number;
  slaLatencyMs: number | null;
  probed: boolean;
  reachable: LatestSample | null;
  latencyMs: LatestSample | null;
  lossPercent: LatestSample | null;
}

export interface SiteSnapshot {
  ciId: string;
  code: string;
  name: string;
  drRole: SiteDrRole;
  criticality: number | null;
}

export interface Breach {
  rule: ReadinessRule;
  subjectCiId: string;
  detail: string;
}

export function linkHealth(link: LinkSnapshot, now: number, probeIntervalMs: number): Health {
  if (!link.probed || link.reachable === null) return 'unknown';
  if (now - link.reachable.at > READINESS.staleAfterProbes * probeIntervalMs) return 'unknown';
  if (link.reachable.value < 1) return 'down';
  const slow = link.latencyMs !== null && link.latencyMs.value >= (link.slaLatencyMs ?? READINESS.degradedLatencyMs);
  const lossy = link.lossPercent !== null && link.lossPercent.value >= READINESS.degradedLossPercent;
  return slow || lossy ? 'degraded' : 'healthy';
}

export function evaluateReadiness(sites: readonly SiteSnapshot[], links: readonly LinkSnapshot[], health: ReadonlyMap<string, Health>): Breach[] {
  const healthy = links.filter((l) => health.get(l.ciId) === 'healthy' && l.fromSite !== null && l.toSite !== null);
  const out: Breach[] = [];

  for (const site of sites) {
    if (site.criticality !== READINESS.criticalSite) continue;
    const paths = healthy.filter((l) => l.fromSite === site.code || l.toSite === site.code).reduce((n, l) => n + Math.max(1, l.diversePaths), 0);
    if (paths < READINESS.minDiversePaths)
      out.push({ rule: 'diverse_paths', subjectCiId: site.ciId, detail: site.name + ' has ' + String(paths) + ' healthy path(s); ' + String(READINESS.minDiversePaths) + ' are required.' });
  }

  const primaries = sites.filter((s) => s.drRole === 'primary').map((s) => s.code);
  const reached = new Set(primaries);
  const queue = [...primaries];
  while (queue.length > 0) {
    const at = queue.shift();
    for (const l of healthy) {
      const next = l.fromSite === at ? l.toSite : l.toSite === at ? l.fromSite : null;
      if (next !== null && !reached.has(next)) {
        reached.add(next);
        queue.push(next);
      }
    }
  }
  for (const site of sites) {
    if (site.drRole !== 'dr' || reached.has(site.code)) continue;
    out.push({
      rule: 'dr_reachable',
      subjectCiId: site.ciId,
      detail: primaries.length === 0 ? 'No primary site is declared, so ' + site.name + ' cannot be reached from one.' : site.name + ' is not reachable from a primary site over healthy links.',
    });
  }

  for (const link of links) {
    if (!link.replication || health.get(link.ciId) === 'healthy') continue;
    out.push({ rule: 'replication_healthy', subjectCiId: link.ciId, detail: 'Replication link ' + link.name + ' is ' + (health.get(link.ciId) ?? 'unknown') + '.' });
  }
  return out;
}

/** Breaches keyed by rule and subject, the identity of an open finding. */
export function breachKey(b: Pick<Breach, 'rule' | 'subjectCiId'>): string {
  return b.rule + '|' + b.subjectCiId;
}

/** REQ-UI-026 — what the redundancy rule needs of one link: its ends, its role, its diverse paths and its health. */
export interface RedundancyLink {
  ciId: string;
  fromSite: string | null;
  toSite: string | null;
  role: string | null;
  diversePaths: number;
  health: Health;
}

/**
 * REQ-UI-026 — the redundancy state between each link's two sites (LINK_REDUNDANCY_STATES), keyed by link CI id. The
 * links joining the same two sites, in either direction, are judged together. Each one counts its diverse paths, and
 * a link that is not down counts as up: an unprobed or stale link has given no sign of failure. A link with an
 * unknown end stands alone.
 */
export function linkRedundancy(links: readonly RedundancyLink[]): Map<string, LinkRedundancy> {
  const pairKey = (l: RedundancyLink): string =>
    l.fromSite === null || l.toSite === null ? 'link:' + l.ciId : [l.fromSite, l.toSite].sort().join('|');
  const groups = new Map<string, RedundancyLink[]>();
  for (const l of links) groups.set(pairKey(l), [...(groups.get(pairKey(l)) ?? []), l]);
  const out = new Map<string, LinkRedundancy>();
  for (const group of groups.values()) {
    const paths = (l: RedundancyLink): number => Math.max(1, l.diversePaths);
    const total = group.reduce((n, l) => n + paths(l), 0);
    const up = group.filter((l) => l.health !== 'down').reduce((n, l) => n + paths(l), 0);
    const state: LinkRedundancy =
      up === 0
        ? 'down'
        : total <= 1
          ? 'single_path'
          : up < total
            ? 'degraded'
            : group.some((l) => l.role === 'backup')
              ? 'active_standby'
              : 'active_active';
    for (const l of group) out.set(l.ciId, state);
  }
  return out;
}
