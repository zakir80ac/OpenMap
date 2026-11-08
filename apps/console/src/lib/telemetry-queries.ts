// REQ-UI-027 — the health and telemetry fleet: one page per request, offset-paged, refreshed on the API's snapshot
// period so a table left open follows the estate.
import { infiniteQueryOptions } from '@tanstack/react-query';
import { TELEMETRY } from '@openmap/constants';
import type { CiLayer, FleetSort } from '@openmap/contracts';
import { gql } from './graphql';
import type { CiSummary } from './queries';

export type FleetHealth = 'healthy' | 'degraded' | 'down' | 'unknown';

export interface FleetFilterInput {
  layers?: CiLayer[];
  health?: FleetHealth[];
  text?: string;
}

/** The row carries its health; the CI's own health field would cost a graph read per row. */
export interface FleetRow {
  ci: Omit<CiSummary, 'health'>;
  site: string | null;
  address: string | null;
  health: FleetHealth;
  cpu: number | null;
  memory: number | null;
  iops: number | null;
  throughput: number | null;
  apdex: number | null;
  observedAt: string | null;
}

export interface FleetPage {
  items: FleetRow[];
  total: number;
  healthy: number;
  degraded: number;
  down: number;
  unknown: number;
  asOf: string;
}

const FLEET_QUERY =
  'query Fleet($filter: FleetFilter, $sort: FleetSort, $first: Int, $offset: Int) { telemetryFleet(filter: $filter, sort: $sort, first: $first, offset: $offset) {' +
  ' total healthy degraded down unknown asOf' +
  ' items { ci { id name displayName code type layer } site address health cpu memory iops throughput apdex observedAt } } }';

export function fleetInfiniteQuery(filter: FleetFilterInput, sort: FleetSort) {
  return infiniteQueryOptions({
    queryKey: ['telemetryFleet', filter, sort] as const,
    queryFn: ({ pageParam, signal }) =>
      gql<{ telemetryFleet: FleetPage }>(FLEET_QUERY, { filter, sort, first: TELEMETRY.defaultPageSize, offset: pageParam }, signal),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((n, p) => n + p.telemetryFleet.items.length, 0);
      return loaded < last.telemetryFleet.total ? loaded : undefined;
    },
    refetchInterval: TELEMETRY.snapshotMs,
  });
}
