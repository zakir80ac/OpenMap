// REQ-UI-007 REQ-DEP-003 — query-string helpers for the dependency map, shared by the server route (which reads
// searchParams) and the client view (which writes them back). Not a client module: a server component may call these.
import { GRAPH } from '@openmap/constants';
import type { ImpactDirection } from '@/lib/queries';

export const DIRECTIONS: readonly ImpactDirection[] = ['upstream', 'downstream', 'both'];

export function isImpactDirection(value: string | undefined): value is ImpactDirection {
  return value !== undefined && (DIRECTIONS as readonly string[]).includes(value);
}

/** Depth from a query string or select value: integers 1..maxImpactDepth; anything else is the default. */
export function parseDepth(value: string | undefined): number {
  const parsed = value === undefined || value.trim() === '' ? Number.NaN : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > GRAPH.maxImpactDepth) return GRAPH.defaultImpactDepth;
  return parsed;
}
