// REQ-INT-017 (ADR-075) — GraphQL operations behind backup and DR awareness: one CI's protection (the CI detail card)
// and the critical CIs a backup does not protect within their RPO (the Protection screen).
import { queryOptions } from '@tanstack/react-query';
import { BACKUP_AWARENESS } from '@openmap/constants';
import type { ProtectionState } from '@openmap/contracts';
import { gql } from './graphql';
import { CI_SUMMARY_FIELDS, type CiSummary } from './queries';

export type { ProtectionState };

export interface BackupCover {
  policy: CiSummary;
  vendor: string;
  policyKind: string;
  server: string | null;
  lastGoodBackupAt: string | null;
  lastResult: string | null;
  restorePoints: number | null;
  rpoMinutes: number | null;
  retentionDays: number | null;
  agents: string[];
  via: CiSummary | null;
}

export interface ProtectionService {
  service: CiSummary;
  tier: number;
  rpoMinutes: number | null;
}

export interface CiProtection {
  ci: CiSummary;
  state: ProtectionState;
  lastGoodBackupAt: string | null;
  policyRpoMinutes: number | null;
  targetRpoMinutes: number;
  ageMinutes: number | null;
  covers: BackupCover[];
  services: ProtectionService[];
}

export interface ProtectionGaps {
  maxTier: number;
  criticalServices: number;
  criticalCis: number;
  protected: number;
  rpoBreached: number;
  unprotected: number;
  truncated: boolean;
  items: CiProtection[];
}

const PROTECTION_FIELDS =
  'state lastGoodBackupAt policyRpoMinutes targetRpoMinutes ageMinutes ci { ' +
  CI_SUMMARY_FIELDS +
  ' } covers { vendor policyKind server lastGoodBackupAt lastResult restorePoints rpoMinutes retentionDays agents policy { ' +
  CI_SUMMARY_FIELDS +
  ' } via { ' +
  CI_SUMMARY_FIELDS +
  ' } } services { tier rpoMinutes service { ' +
  CI_SUMMARY_FIELDS +
  ' } }';

const CI_PROTECTION_QUERY =
  'query CiProtection($ciId: UUID!) { ciProtection(ciId: $ciId) { ' + PROTECTION_FIELDS + ' } }';

const GAPS_QUERY =
  'query ProtectionGaps($maxTier: Int, $first: Int) { protectionGaps(maxTier: $maxTier, first: $first) { maxTier criticalServices criticalCis protected rpoBreached unprotected truncated items { ' +
  PROTECTION_FIELDS +
  ' } } }';

/** Protection of one CI; null for a type no backup protects. */
export function ciProtectionQuery(ciId: string) {
  return queryOptions({
    queryKey: ['ci-protection', ciId] as const,
    queryFn: ({ signal }) =>
      gql<{ ciProtection: CiProtection | null }>(CI_PROTECTION_QUERY, { ciId }, signal).then(
        (d) => d.ciProtection,
      ),
  });
}

/** Critical CIs unprotected or past their RPO, for services of `maxTier` or more critical. */
export function protectionGapsQuery(
  maxTier: number = BACKUP_AWARENESS.criticalMaxTier,
  first: number = BACKUP_AWARENESS.gapRows,
) {
  return queryOptions({
    queryKey: ['protection-gaps', maxTier, first] as const,
    queryFn: ({ signal }) =>
      gql<{ protectionGaps: ProtectionGaps }>(GAPS_QUERY, { maxTier, first }, signal).then(
        (d) => d.protectionGaps,
      ),
  });
}

/** CI types a backup can protect: the detail view shows the Protection card for these only. */
export function isProtectable(type: string): boolean {
  return (BACKUP_AWARENESS.protectableTypes as readonly string[]).includes(type);
}
