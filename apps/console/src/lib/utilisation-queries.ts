// REQ-CMDB-034 — GraphQL operations behind the Utilisation screen and a CI's Utilisation tab.
import { queryOptions } from '@tanstack/react-query';
import type { UtilisationMeasure, UtilisationState } from '@openmap/contracts';
import { gql } from './graphql';
import { CI_SUMMARY_FIELDS, type CiSummary } from './queries';

export type UtilisationSort = UtilisationMeasure | 'name';

export interface UtilisationRow {
  ci: CiSummary;
  state: UtilisationState;
  cpu: number | null;
  memory: number | null;
  disk: number | null;
  power: number | null;
  observedAt: string | null;
}

export interface UtilisationPage {
  items: UtilisationRow[];
  total: number;
  hot: number;
  idle: number;
  averageCpu: number | null;
  averageMemory: number | null;
  powerWatts: number | null;
}

export interface UtilisationFilter {
  types?: string[];
  state?: UtilisationState;
  text?: string;
}

export interface UtilisationSeries {
  measure: UtilisationMeasure;
  metric: string;
  unit: string;
  latest: number | null;
  latestAt: string | null;
  average: number | null;
  peak: number | null;
  points: Array<{ at: string; value: number; peak: number }>;
}

export interface CiUtilisation {
  state: UtilisationState;
  hours: number;
  series: UtilisationSeries[];
}

const PAGE_QUERY =
  'query Utilisation($filter: UtilisationFilter, $sort: UtilisationSort, $first: Int, $offset: Int) { utilisation(filter: $filter, sort: $sort, first: $first, offset: $offset) { total hot idle averageCpu averageMemory powerWatts items { state cpu memory disk power observedAt ci { ' +
  CI_SUMMARY_FIELDS +
  ' } } } }';
const CI_QUERY =
  'query CiUtilisation($id: UUID!, $hours: Int) { ci(id: $id) { id utilisation(hours: $hours) { state hours series { measure metric unit latest latestAt average peak points { at value peak } } } } }';

export function utilisationQuery(
  filter: UtilisationFilter,
  sort: UtilisationSort,
  first: number,
  offset: number,
) {
  return queryOptions({
    queryKey: ['utilisation', filter, sort, first, offset] as const,
    queryFn: ({ signal }) =>
      gql<{ utilisation: UtilisationPage }>(PAGE_QUERY, { filter, sort, first, offset }, signal).then(
        (d) => d.utilisation,
      ),
  });
}

export function ciUtilisationQuery(id: string, hours: number) {
  return queryOptions({
    queryKey: ['ci-utilisation', id, hours] as const,
    queryFn: ({ signal }) =>
      gql<{ ci: { id: string; utilisation: CiUtilisation | null } | null }>(
        CI_QUERY,
        { id, hours },
        signal,
      ).then((d) => d.ci?.utilisation ?? null),
  });
}
