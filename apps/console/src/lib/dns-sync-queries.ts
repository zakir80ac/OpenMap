// REQ-IPAM-003 (ADR-055) — two-way DNS sync as the IPAM DNS tab reads and writes it: the zones kept in sync and the
// record changes with their state.
import { queryOptions } from '@tanstack/react-query';
import type { DnsChangeOp, DnsChangeState, DnsRecordType } from '@openmap/contracts';
import { gql } from './graphql';

export interface DnsZoneSync {
  id: string;
  zone: string;
  server: string;
  port: number;
  tsigKeyName: string | null;
  credentialRef: string | null;
  siteId: string;
  enabled: boolean;
  lastPullAt: string | null;
  lastPushAt: string | null;
  lastError: string | null;
  pending: number;
}

export interface DnsChange {
  id: string;
  zone: string;
  op: DnsChangeOp;
  name: string;
  recordType: DnsRecordType;
  value: string;
  ttl: number;
  state: DnsChangeState;
  error: string | null;
  requestedBy: string;
  requestedAt: string;
  settledAt: string | null;
}

export interface DnsZoneSyncInput {
  zone: string;
  server: string;
  port: number | null;
  tsigKeyName: string | null;
  credentialRef: string | null;
  siteId: string;
}

export interface DnsChangeInput {
  zone: string;
  op: DnsChangeOp;
  name: string;
  recordType: DnsRecordType;
  value: string;
  ttl: number | null;
}

const ZONE_FIELDS = 'id zone server port tsigKeyName credentialRef siteId enabled lastPullAt lastPushAt lastError pending';
const CHANGE_FIELDS = 'id zone op name recordType value ttl state error requestedBy requestedAt settledAt';

export const dnsSyncKey = ['dns-sync'] as const;

/** Re-read while a change is on its way, so its state follows the sync round. */
export function dnsSyncQuery(refetchMs: number) {
  return queryOptions({
    queryKey: dnsSyncKey,
    queryFn: ({ signal }) =>
      gql<{ dnsZoneSyncs: DnsZoneSync[]; dnsChanges: DnsChange[] }>('query DnsSync { dnsZoneSyncs { ' + ZONE_FIELDS + ' } dnsChanges { ' + CHANGE_FIELDS + ' } }', undefined, signal),
    refetchInterval: (query) => (query.state.data?.dnsChanges.some((c) => c.state === 'pending' || c.state === 'sent') === true ? refetchMs : false),
  });
}

export function saveDnsZoneSync(input: DnsZoneSyncInput): Promise<DnsZoneSync> {
  return gql<{ upsertDnsZoneSync: DnsZoneSync }>('mutation SaveDnsZoneSync($input: DnsZoneSyncInput!) { upsertDnsZoneSync(input: $input) { ' + ZONE_FIELDS + ' } }', { input }).then((d) => d.upsertDnsZoneSync);
}

export function requestDnsChange(input: DnsChangeInput): Promise<DnsChange> {
  return gql<{ requestDnsChange: DnsChange }>('mutation RequestDnsChange($input: DnsChangeInput!) { requestDnsChange(input: $input) { ' + CHANGE_FIELDS + ' } }', { input }).then((d) => d.requestDnsChange);
}
