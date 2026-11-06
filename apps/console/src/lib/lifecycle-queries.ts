// REQ-CMDB-023 REQ-CMDB-025 (ADR-039) — GraphQL operations behind the Lifecycle screen.
import { queryOptions } from '@tanstack/react-query';
import type { LifecycleKind, LifecycleState } from '@openmap/contracts';
import { gql } from './graphql';
import { CI_SUMMARY_FIELDS, type CiSummary } from './queries';

export interface LifecycleEntry {
  source: string;
  label: string;
  releaseDate: string | null;
  supportEnd: string | null;
  endOfSupport: string | null;
  supportEnded: boolean;
  extendedSupportEnd: string | null;
  latest: string | null;
  lts: boolean;
  link: string | null;
}

export interface LifecycleRelease {
  key: string;
  kind: LifecycleKind;
  product: string | null;
  cycle: string | null;
  label: string;
  count: number;
  versions: string[];
  entry: LifecycleEntry | null;
  state: LifecycleState;
  daysLeft: number | null;
  patchBehind: number | null;
  oldestPatchAt: string | null;
}

export interface LifecycleReleasePage {
  rows: LifecycleRelease[];
  supported: number;
  ending: number;
  ended: number;
  unknown: number;
}

export interface LifecycleHardware {
  key: string;
  ciType: string;
  manufacturer: string | null;
  model: string | null;
  count: number;
  dated: number;
  endOfSale: string | null;
  endOfSupport: string | null;
  sources: string[];
  state: LifecycleState;
  daysLeft: number | null;
}

export interface LifecycleCatalogue {
  sources: Array<{ source: string; products: number; releases: number; fetchedAt: string }>;
  url: string;
  syncAllowed: boolean;
}

export interface ReleaseFilter {
  kind?: LifecycleKind;
  state?: LifecycleState;
  text?: string;
}

const RELEASES_QUERY =
  'query LifecycleReleases($filter: LifecycleReleaseFilter) { lifecycleReleases(filter: $filter) { supported ending ended unknown rows { key kind product cycle label count versions state daysLeft patchBehind oldestPatchAt entry { source label releaseDate supportEnd endOfSupport supportEnded extendedSupportEnd latest lts link } } } }';
const INSTANCES_QUERY =
  'query LifecycleInstances($filter: LifecycleReleaseFilter) { lifecycleReleases(filter: $filter) { rows { key instances { ' +
  CI_SUMMARY_FIELDS +
  ' } } } }';
const HARDWARE_QUERY =
  'query LifecycleHardware($filter: LifecycleHardwareFilter) { lifecycleHardware(filter: $filter) { key ciType manufacturer model count dated endOfSale endOfSupport sources state daysLeft } }';
const CATALOGUE_QUERY =
  '{ lifecycleCatalogue { url syncAllowed sources { source products releases fetchedAt } } }';
const SYNC_MUTATION =
  'mutation SyncLifecycle { syncLifecycleCatalogue { failed catalogue { url syncAllowed sources { source products releases fetchedAt } } } }';

export function lifecycleReleasesQuery(filter: ReleaseFilter) {
  return queryOptions({
    queryKey: ['lifecycle-releases', filter] as const,
    queryFn: ({ signal }) =>
      gql<{ lifecycleReleases: LifecycleReleasePage }>(RELEASES_QUERY, { filter }, signal).then(
        (d) => d.lifecycleReleases,
      ),
  });
}

/** The CIs on one release (the row's own filter narrowed by its key on the client). */
export function lifecycleInstancesQuery(filter: ReleaseFilter, key: string) {
  return queryOptions({
    queryKey: ['lifecycle-instances', filter, key] as const,
    queryFn: ({ signal }) =>
      gql<{ lifecycleReleases: { rows: Array<{ key: string; instances: CiSummary[] }> } }>(
        INSTANCES_QUERY,
        { filter },
        signal,
      ).then((d) => d.lifecycleReleases.rows.find((r) => r.key === key)?.instances ?? []),
  });
}

export function lifecycleHardwareQuery(filter: { state?: LifecycleState; text?: string }) {
  return queryOptions({
    queryKey: ['lifecycle-hardware', filter] as const,
    queryFn: ({ signal }) =>
      gql<{ lifecycleHardware: LifecycleHardware[] }>(HARDWARE_QUERY, { filter }, signal).then(
        (d) => d.lifecycleHardware,
      ),
  });
}

export function lifecycleCatalogueQuery() {
  return queryOptions({
    queryKey: ['lifecycle-catalogue'] as const,
    queryFn: ({ signal }) =>
      gql<{ lifecycleCatalogue: LifecycleCatalogue }>(CATALOGUE_QUERY, undefined, signal).then(
        (d) => d.lifecycleCatalogue,
      ),
  });
}

export function syncLifecycleCatalogue(): Promise<{ failed: string[]; catalogue: LifecycleCatalogue }> {
  return gql<{ syncLifecycleCatalogue: { failed: string[]; catalogue: LifecycleCatalogue } }>(
    SYNC_MUTATION,
  ).then((d) => d.syncLifecycleCatalogue);
}
