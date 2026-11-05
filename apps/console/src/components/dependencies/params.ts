// REQ-UI-007 REQ-DEP-003 REQ-DEP-005 REQ-DEP-001 — query-string helpers for the dependency map, shared by the server route (which reads
// searchParams) and the client view (which writes them back). Not a client module: a server component may call these.
import { GRAPH } from '@openmap/constants';
import { isLayoutMode, type LayoutMode } from '@/lib/layout-mode';
import type { ImpactDirection } from '@/lib/queries';

export const DIRECTIONS: readonly ImpactDirection[] = ['upstream', 'downstream', 'both'];

export function isImpactDirection(value: string | undefined): value is ImpactDirection {
  return value !== undefined && (DIRECTIONS as readonly string[]).includes(value);
}

/** Depth from a query string or select value: integers 1..maxImpactDepth; anything else is the default. */
export function parseDepth(value: string | undefined): number {
  const parsed = value === undefined || value.trim() === '' ? Number.NaN : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > GRAPH.maxImpactDepth)
    return GRAPH.defaultImpactDepth;
  return parsed;
}

/** Layout mode from the query string; anything but a known mode is the lane layout. */
export function parseLayout(value: string | undefined): LayoutMode {
  return isLayoutMode(value) ? value : 'lane';
}

/**
 * REQ-DEP-001 REQ-DEP-004 (ADR-030, ADR-031): the screen's maps, `view=topology` or `view=application` in the URL;
 * anything else is the impact map.
 */
export const DEPENDENCY_VIEWS = ['impact', 'application', 'topology'] as const;
export type DependencyView = (typeof DEPENDENCY_VIEWS)[number];

export function parseView(value: string | undefined): DependencyView {
  return (DEPENDENCY_VIEWS as readonly string[]).includes(value ?? '') ? (value as DependencyView) : 'impact';
}
