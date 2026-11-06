// REQ-CMDB-014 (ADR-037) — GraphQL operations behind the CI Parts tab and the Parts register.
import { queryOptions } from '@tanstack/react-query';
import type { ComponentKind } from '@openmap/contracts';
import { gql } from './graphql';
import { CI_SUMMARY_FIELDS, type CiSummary } from './queries';

export type ComponentDetails = Record<string, string | number | boolean>;

export interface HardwareComponent {
  id: string;
  kind: ComponentKind;
  slot: string;
  model: string | null;
  manufacturer: string | null;
  serialNumber: string | null;
  partNumber: string | null;
  capacityBytes: number | null;
  firmware: string | null;
  details: ComponentDetails;
  firstSeenAt: string;
  lastSeenAt: string;
  removedAt: string | null;
}

export interface RegisterComponent extends HardwareComponent {
  ci: CiSummary;
}

export interface ComponentModelCount {
  kind: ComponentKind;
  model: string | null;
  count: number;
}

export interface ComponentPage {
  items: RegisterComponent[];
  total: number;
  models: ComponentModelCount[];
}

export interface ComponentFilter {
  kind?: ComponentKind;
  text?: string;
  includeRemoved?: boolean;
}

const PART_FIELDS =
  'id kind slot model manufacturer serialNumber partNumber capacityBytes firmware details firstSeenAt lastSeenAt removedAt';
const CI_PARTS_QUERY =
  'query CiParts($id: UUID!, $removed: Boolean) { ci(id: $id) { id components(includeRemoved: $removed) { ' +
  PART_FIELDS +
  ' } } }';
const PARTS_QUERY =
  'query Parts($filter: ComponentFilter, $first: Int, $offset: Int) { components(filter: $filter, first: $first, offset: $offset) { total models { kind model count } items { ' +
  PART_FIELDS +
  ' ci { ' +
  CI_SUMMARY_FIELDS +
  ' } } } }';

export function ciPartsQuery(id: string, includeRemoved: boolean) {
  return queryOptions({
    queryKey: ['ci-parts', id, includeRemoved] as const,
    queryFn: ({ signal }) =>
      gql<{ ci: { id: string; components: HardwareComponent[] } | null }>(
        CI_PARTS_QUERY,
        { id, removed: includeRemoved },
        signal,
      ).then((d) => d.ci?.components ?? []),
  });
}

export function partsQuery(filter: ComponentFilter, first: number, offset: number) {
  return queryOptions({
    queryKey: ['parts', filter, first, offset] as const,
    queryFn: ({ signal }) =>
      gql<{ components: ComponentPage }>(PARTS_QUERY, { filter, first, offset }, signal).then(
        (d) => d.components,
      ),
  });
}
