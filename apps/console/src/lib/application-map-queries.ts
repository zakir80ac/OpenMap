// REQ-DEP-004 (ADR-031) — the layered application map for the Dependencies screen: one application's tiers, where
// each component runs, and its dependencies inside the application and to other applications.
import { queryOptions } from '@tanstack/react-query';
import { gql } from './graphql';
import { CI_SUMMARY_FIELDS, type CiSummary } from './queries';

export interface ApplicationComponent {
  ci: CiSummary;
  tier: string;
  technology: string | null;
  protocol: string | null;
  port: number | null;
  deployment: string | null;
  instances: number | null;
}

export interface Placement {
  ci: CiSummary;
  parentId: string;
  relationship: string;
  hop: number;
}

export type DependencyDirection = 'internal' | 'outbound' | 'inbound';

export interface ApplicationDependency {
  id: string;
  from: CiSummary;
  to: CiSummary;
  type: string;
  direction: DependencyDirection;
  otherApplication: CiSummary | null;
  derived: boolean;
  protocol: string | null;
  ports: number[];
  flows: number | null;
  confidence: number;
}

export interface ApplicationMap {
  application: CiSummary;
  services: CiSummary[];
  tiers: Array<{ tier: string; components: ApplicationComponent[] }>;
  placements: Placement[];
  dependencies: ApplicationDependency[];
  truncated: boolean;
  durationMs: number;
}

const CI = '{ ' + CI_SUMMARY_FIELDS + ' }';
const APPLICATION_MAP_QUERY =
  'query ApplicationMap($id: UUID!) { applicationMap(id: $id) { truncated durationMs application ' +
  CI +
  ' services ' +
  CI +
  ' tiers { tier components { tier technology protocol port deployment instances ci ' +
  CI +
  ' } } placements { parentId relationship hop ci ' +
  CI +
  ' } dependencies { id type direction derived protocol ports flows confidence from ' +
  CI +
  ' to ' +
  CI +
  ' otherApplication ' +
  CI +
  ' } } }';

export function applicationMapQuery(id: string | null) {
  return queryOptions({
    queryKey: ['application-map', id] as const,
    queryFn: ({ signal }) =>
      gql<{ applicationMap: ApplicationMap | null }>(APPLICATION_MAP_QUERY, { id }, signal).then((d) => d.applicationMap),
    enabled: id !== null,
  });
}
