// REQ-BSM-002 — health propagation. A service is modelled as redundancy groups of components; the
// service state is the worst group state. Pure and deterministic so every rule is unit-tested.
import { BSM } from '@openmap/constants';

export type Health = (typeof BSM.healthOrder)[number];

export interface RedundancyGroup {
  name: string;
  memberCiIds: string[];
  /** Healthy members needed for the group to be fully up. 1 for active/standby pairs. */
  minHealthy: number;
}

export interface ServiceModel {
  serviceCiId: string;
  groups: RedundancyGroup[];
}

export interface GroupState {
  name: string;
  state: Health;
  healthy: number;
  degraded: number;
  down: number;
  unknown: number;
  minHealthy: number;
}

export interface ServiceState {
  serviceCiId: string;
  state: Health;
  groups: GroupState[];
  /** Components whose non-healthy state drives the worst group. */
  rootCauseCiIds: string[];
}

function rank(h: Health): number {
  return BSM.healthOrder.indexOf(h);
}

export function worst(a: Health, b: Health): Health {
  return rank(a) >= rank(b) ? a : b;
}

export function groupState(group: RedundancyGroup, health: ReadonlyMap<string, Health>): GroupState {
  let healthy = 0;
  let degraded = 0;
  let down = 0;
  let unknown = 0;
  for (const id of group.memberCiIds) {
    const h = health.get(id) ?? 'unknown';
    if (h === 'healthy') healthy++;
    else if (h === 'degraded') degraded++;
    else if (h === 'down') down++;
    else unknown++;
  }
  // Degraded members still serve, so they count toward the minimum but mark the group degraded.
  const serving = healthy + degraded;
  let state: Health;
  if (serving < group.minHealthy) state = 'down';
  else if (degraded > 0 || serving === group.minHealthy && group.memberCiIds.length > group.minHealthy) state = 'degraded';
  else if (unknown > 0 && healthy < group.minHealthy) state = 'unknown';
  else state = 'healthy';
  return { name: group.name, state, healthy, degraded, down, unknown, minHealthy: group.minHealthy };
}

export function propagate(model: ServiceModel, health: ReadonlyMap<string, Health>): ServiceState {
  const groups = model.groups.map((g) => groupState(g, health));
  let state: Health = 'healthy';
  for (const g of groups) state = worst(state, g.state);
  const worstRank = rank(state);
  const rootCauseCiIds = model.groups
    .filter((_g, i) => rank(groups[i]!.state) === worstRank && worstRank > 0)
    .flatMap((g) => g.memberCiIds.filter((id) => (health.get(id) ?? 'unknown') !== 'healthy'));
  return { serviceCiId: model.serviceCiId, state, groups, rootCauseCiIds: [...new Set(rootCauseCiIds)] };
}

/** Propagates every service and returns the ones whose state differs from `previous`. */
export function propagateAll(models: readonly ServiceModel[], health: ReadonlyMap<string, Health>, previous: ReadonlyMap<string, Health>): { states: ServiceState[]; changed: ServiceState[] } {
  const states = models.map((m) => propagate(m, health));
  const changed = states.filter((s) => previous.get(s.serviceCiId) !== s.state);
  return { states, changed };
}
