// REQ-INT-017 (ADR-075) — shared labels for backup protection: state badges, vendor, policy kind and result names, and
// durations (RPO, backup age) in minutes, hours or days.
import { BSM, TIME } from '@openmap/constants';
import {
  BACKUP_POLICY_KINDS,
  BACKUP_RESULTS,
  BACKUP_VENDORS,
  type BackupPolicyKind,
  type BackupResult,
  type BackupVendor,
  type ProtectionState,
} from '@openmap/contracts';
import type { MessageKey } from '@openmap/i18n';
import type { Formatters } from '@/lib/format';
import type { Translate } from '@/providers';

export const STATE_BADGE: Record<ProtectionState, 'healthy' | 'degraded' | 'down'> = {
  protected: 'healthy',
  rpo_breached: 'degraded',
  unprotected: 'down',
};

export const STATE_KEY: Record<ProtectionState, MessageKey> = {
  protected: 'protection.state.protected',
  rpo_breached: 'protection.state.rpo_breached',
  unprotected: 'protection.state.unprotected',
};

const VENDOR_KEY: Record<BackupVendor, MessageKey> = {
  veeam: 'protection.vendor.veeam',
  commvault: 'protection.vendor.commvault',
  rubrik: 'protection.vendor.rubrik',
};

const KIND_KEY: Record<BackupPolicyKind, MessageKey> = {
  job: 'protection.kind.job',
  plan: 'protection.kind.plan',
  storage_policy: 'protection.kind.storage_policy',
  sla_domain: 'protection.kind.sla_domain',
};

const RESULT_KEY: Record<BackupResult, MessageKey> = {
  success: 'protection.result.success',
  warning: 'protection.result.warning',
  failed: 'protection.result.failed',
  running: 'protection.result.running',
  none: 'protection.result.none',
};

const RESULT_BADGE: Record<BackupResult, 'healthy' | 'at_risk' | 'down' | 'unknown'> = {
  success: 'healthy',
  warning: 'at_risk',
  failed: 'down',
  running: 'unknown',
  none: 'unknown',
};

function member<T extends string>(list: readonly T[], value: string): value is T {
  return (list as readonly string[]).includes(value);
}

/** The product name of a backup vendor; an unknown vendor is shown as reported. */
export function vendorLabel(t: Translate, vendor: string): string {
  return member(BACKUP_VENDORS, vendor) ? t(VENDOR_KEY[vendor]) : vendor;
}

export function kindLabel(t: Translate, kind: string): string {
  return member(BACKUP_POLICY_KINDS, kind) ? t(KIND_KEY[kind]) : kind;
}

export function resultLabel(t: Translate, result: string): string {
  return member(BACKUP_RESULTS, result) ? t(RESULT_KEY[result]) : result;
}

export function resultBadge(result: string): 'healthy' | 'at_risk' | 'down' | 'unknown' {
  return member(BACKUP_RESULTS, result) ? RESULT_BADGE[result] : 'unknown';
}

const MINUTES_PER_HOUR = BSM.minutesPerDay / TIME.hoursPerDay;

/** A span of minutes in the largest whole unit that fits: minutes, hours or days. */
export function duration(t: Translate, format: Formatters, minutes: number): string {
  if (minutes < MINUTES_PER_HOUR) return t('protection.duration.minutes', { count: format.integer(minutes) });
  if (minutes < BSM.minutesPerDay)
    return t('protection.duration.hours', { count: format.integer(Math.floor(minutes / MINUTES_PER_HOUR)) });
  return t('protection.duration.days', { count: format.integer(Math.floor(minutes / BSM.minutesPerDay)) });
}
