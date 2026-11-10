// REQ-INT-012 (ADR-073) — monitoring alerts as the Monitoring events screen reads them, the mapping of an unresolved
// source to a CI, a manual clear, and the address each monitoring integration receives events at.
import { queryOptions } from '@tanstack/react-query';
import { MONITORING } from '@openmap/constants';
import type { MonitoringSeverity, MonitoringStatus, MonitoringTarget, MonitoringTargetKind } from '@openmap/contracts';
import { gql } from './graphql';
import { CI_SUMMARY_FIELDS, type CiSummary } from './queries';

export interface MonitoringAlert {
  id: string;
  integrationId: string;
  integrationName: string;
  vendor: string;
  fingerprint: string;
  status: MonitoringStatus;
  severity: MonitoringSeverity;
  effect: 'down' | 'degraded' | null;
  title: string;
  description: string | null;
  sourceUrl: string | null;
  targets: MonitoringTarget[];
  ci: CiSummary | null;
  resolution: 'ci_id' | 'mapping' | 'identity' | null;
  startsAt: string;
  endsAt: string | null;
  expiresAt: string | null;
  firstReceivedAt: string;
  lastReceivedAt: string;
  receivedCount: number;
}

export interface MonitoringMapping {
  id: string;
  sourceKey: string;
  ci: CiSummary | null;
  createdBy: string;
  createdAt: string;
}

export interface MonitoringAlerts {
  alerts: MonitoringAlert[];
  firing: number;
  unresolved: number;
  mappings: MonitoringMapping[];
}

export type MonitoringFilter = 'all' | 'firing' | 'unresolved';

const ALERT_FIELDS =
  'id integrationId integrationName vendor fingerprint status severity effect title description sourceUrl targets { kind value } ci { ' +
  CI_SUMMARY_FIELDS +
  ' } resolution startsAt endsAt expiresAt firstReceivedAt lastReceivedAt receivedCount';
const MAPPING_FIELDS = 'id sourceKey ci { ' + CI_SUMMARY_FIELDS + ' } createdBy createdAt';
const LIST_QUERY =
  'query MonitoringAlerts($status: MonitoringAlertStatus, $unresolvedOnly: Boolean, $first: Int) { monitoringAlerts(status: $status, unresolvedOnly: $unresolvedOnly, first: $first) { alerts { ' +
  ALERT_FIELDS +
  ' } firing unresolved mappings { ' +
  MAPPING_FIELDS +
  ' } } }';

export const monitoringKey = ['monitoringAlerts'] as const;

export function monitoringAlertsQuery(filter: MonitoringFilter) {
  const variables = {
    status: filter === 'firing' ? 'firing' : null,
    unresolvedOnly: filter === 'unresolved',
    first: MONITORING.defaultPageSize,
  };
  return queryOptions({
    queryKey: [...monitoringKey, filter] as const,
    queryFn: ({ signal }) => gql<{ monitoringAlerts: MonitoringAlerts }>(LIST_QUERY, variables, signal).then((d) => d.monitoringAlerts),
    refetchInterval: MONITORING.screenRefreshMs,
  });
}

export function mapMonitoringSource(sourceKey: string, ciId: string): Promise<MonitoringMapping> {
  return gql<{ mapMonitoringSource: MonitoringMapping }>(
    'mutation MapMonitoringSource($sourceKey: String!, $ciId: UUID!) { mapMonitoringSource(sourceKey: $sourceKey, ciId: $ciId) { ' + MAPPING_FIELDS + ' } }',
    { sourceKey, ciId },
  ).then((d) => d.mapMonitoringSource);
}

export function clearMonitoringAlert(id: string): Promise<MonitoringAlert> {
  return gql<{ clearMonitoringAlert: MonitoringAlert }>('mutation ClearMonitoringAlert($id: UUID!) { clearMonitoringAlert(id: $id) { ' + ALERT_FIELDS + ' } }', { id }).then(
    (d) => d.clearMonitoringAlert,
  );
}

/** Where a monitoring integration receives events: the API origin, the ingest path and the integration id. */
export function ingestAddress(integrationId: string): string {
  const origin = (process.env.NEXT_PUBLIC_API_URL ?? '').replace(/\/$/, '');
  return origin + '/' + MONITORING.ingestPath + '/' + integrationId;
}

/** The values an operator can map: what the alert named, except a CI id. */
export function mappableKeys(targets: readonly MonitoringTarget[]): Array<{ kind: MonitoringTargetKind; value: string }> {
  return targets.filter((t) => t.kind !== 'ci_id');
}
