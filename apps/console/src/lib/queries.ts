// REQ-UI-004 REQ-UI-005 REQ-UI-008 — typed operations over the frozen GraphQL contract (packages/contracts/graphql/schema.graphql)
// and their TanStack Query option builders. Only the fields the console renders are selected.
import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';
import { GRAPH, type BSM } from '@openmap/constants';
import type { CiLayer } from '@openmap/contracts';
import { gql } from './graphql';

export type HealthState = (typeof BSM.healthOrder)[number];

export interface LayerSummary {
  layer: CiLayer;
  count: number;
  healthy: number;
  degraded: number;
  down: number;
  visible: boolean;
}

export interface CiRef {
  id: string;
  displayName: string;
}

export interface ServiceHealth {
  service: CiRef & { name: string };
  state: HealthState;
  since: string;
  rootCauses: CiRef[];
  slaTarget: number;
  errorBudgetRemainingMinutes: number;
}

export interface CiRow {
  id: string;
  type: string;
  layer: CiLayer;
  displayName: string;
  health: HealthState;
  observedAt: string;
}

export interface CiConnection {
  totalCount: number;
  pageInfo: { endCursor: string | null; hasNextPage: boolean };
  edges: Array<{ cursor: string; node: CiRow }>;
}

export interface CiFilterInput {
  layers?: CiLayer[];
  text?: string;
}

const LAYERS_QUERY = ['query Layers {', '  layers { layer count healthy degraded down visible }', '}'].join('\n');

const SERVICES_QUERY = [
  'query Services {',
  '  services {',
  '    service { id name displayName }',
  '    state since slaTarget errorBudgetRemainingMinutes',
  '    rootCauses { id displayName }',
  '  }',
  '}',
].join('\n');

const CIS_QUERY = [
  'query Cis($filter: CiFilter, $first: Int, $after: String) {',
  '  cis(filter: $filter, first: $first, after: $after) {',
  '    totalCount',
  '    pageInfo { endCursor hasNextPage }',
  '    edges { cursor node { id type layer displayName health observedAt } }',
  '  }',
  '}',
].join('\n');

export const queryKeys = {
  layers: ['layers'] as const,
  services: ['services'] as const,
  cis: (filter: CiFilterInput) => ['cis', filter] as const,
};

export function layersQuery() {
  return queryOptions({
    queryKey: queryKeys.layers,
    queryFn: ({ signal }) => gql<{ layers: LayerSummary[] }>(LAYERS_QUERY, undefined, signal),
    select: (data) => data.layers,
  });
}

export function servicesQuery() {
  return queryOptions({
    queryKey: queryKeys.services,
    queryFn: ({ signal }) => gql<{ services: ServiceHealth[] }>(SERVICES_QUERY, undefined, signal),
    select: (data) => data.services,
  });
}

export function cisInfiniteQuery(filter: CiFilterInput) {
  return infiniteQueryOptions({
    queryKey: queryKeys.cis(filter),
    queryFn: ({ pageParam, signal }) =>
      gql<{ cis: CiConnection }>(CIS_QUERY, { filter, first: GRAPH.defaultPageSize, after: pageParam }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last.cis.pageInfo.hasNextPage ? last.cis.pageInfo.endCursor : undefined),
  });
}
