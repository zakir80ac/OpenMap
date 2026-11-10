// REQ-INT-017 (ADR-075) — backup and DR awareness. The `backup` collector reports each backup policy of Veeam Backup &
// Replication (a job), Commvault (a plan, or the storage policy of a subclient without one) and Rubrik CDM (an SLA
// domain) as a `backup_policy` CI, and every CI a policy protects as a `backed_by` edge from that CI to the policy,
// carrying the last good backup. This module names the attributes on both, the job options, and judges a CI's
// protection: protected, RPO breached or unprotected.
import { BACKUP_AWARENESS, TIME } from '@openmap/constants';
import { z } from 'zod';

export const BACKUP_VENDORS = BACKUP_AWARENESS.vendors;
export type BackupVendor = (typeof BACKUP_VENDORS)[number];
export const backupVendorSchema = z.enum(BACKUP_VENDORS);

/** What a policy is in its product: a Veeam job, a Commvault plan or storage policy, a Rubrik SLA domain. */
export const BACKUP_POLICY_KINDS = ['job', 'plan', 'storage_policy', 'sla_domain'] as const;
export type BackupPolicyKind = (typeof BACKUP_POLICY_KINDS)[number];

/** Outcome of a policy's or an object's last run, normalised across the three products. */
export const BACKUP_RESULTS = ['success', 'warning', 'failed', 'running', 'none'] as const;
export type BackupResult = (typeof BACKUP_RESULTS)[number];

/** A CI's protection: covered and within its RPO, covered but past it (or never backed up), or not covered at all. */
export const PROTECTION_STATES = ['protected', 'rpo_breached', 'unprotected'] as const;
export type ProtectionState = (typeof PROTECTION_STATES)[number];

/** CI types a backup can protect; the protection view and the gaps list cover these. */
export const PROTECTABLE_CI_TYPES = BACKUP_AWARENESS.protectableTypes;
export type ProtectableCiType = (typeof PROTECTABLE_CI_TYPES)[number];

/** Attributes of a `backup_policy` CI (identity: vendor, serverId, policyId). */
export const BACKUP_POLICY_ATTRIBUTES = {
  vendor: 'vendor',
  /** The backup server's own id: Veeam's vbrId, the Commvault CommServe host, the Rubrik cluster id. */
  serverId: 'serverId',
  /** The address the collector reached the backup server on. */
  server: 'server',
  policyId: 'policyId',
  policyKind: 'policyKind',
  /** Interval between scheduled backups, the RPO the policy can meet, in minutes. */
  rpoMinutes: 'rpoMinutes',
  retentionDays: 'retentionDays',
  /** Veeam jobs that keep a count of restore points rather than days. */
  retentionPoints: 'retentionPoints',
  enabled: 'enabled',
  lastRunAt: 'lastRunAt',
  lastResult: 'lastResult',
  /** Objects the policy protects that the collector matched to a CI. */
  protectedObjects: 'protectedObjects',
  /** Objects it protects that it could not match, and the first of their names. */
  unmatchedObjects: 'unmatchedObjects',
  unmatchedNames: 'unmatchedNames',
  provenance: 'provenance',
} as const;

/** Attributes of a `backed_by` edge from a protected CI to a `backup_policy`. */
export const BACKUP_COVER_ATTRIBUTES = {
  vendor: 'vendor',
  /** The object's name in the backup product (a VM name, a Commvault client, a Rubrik fileset host). */
  objectName: 'objectName',
  /** Newest restore point that completed with success or a warning (RFC 3339), absent when there is none. */
  lastGoodBackupAt: 'lastGoodBackupAt',
  lastBackupAt: 'lastBackupAt',
  lastResult: 'lastResult',
  restorePoints: 'restorePoints',
  rpoMinutes: 'rpoMinutes',
  retentionDays: 'retentionDays',
  /** Commvault agents (iDataAgents) on the client: "File System", "SQL Server"… */
  agents: 'agents',
  subclients: 'subclients',
} as const;

/** Options of a `backup` collector job. */
export const BACKUP_JOB_OPTIONS = {
  vendor: 'vendor',
  /** Veeam: the x-api-version header value (the REST revision the server speaks). */
  apiVersion: 'apiVersion',
  /** Commvault: the REST base path under the Command Center host (default /webconsole/api). */
  apiPath: 'apiPath',
  verifyTls: 'verifyTls',
  caCertPem: 'caCertPem',
  /** CMDB candidates the collector matches vendor objects to (backupInventoryEntrySchema). */
  inventory: 'inventory',
} as const;

/**
 * One CMDB candidate a vendor object may be: its type, the identity the CMDB stores, and every lower-case spelling a
 * backup product may name it by (VM or host name, FQDN, address, instance UUID, `<vcenter>:<moRef>`). The collector
 * matches an object on its most specific key that names exactly one candidate.
 */
export const backupInventoryEntrySchema = z.object({
  type: z.enum(BACKUP_AWARENESS.inventoryTypes),
  identity: z.record(z.string().min(1), z.string().min(1)),
  keys: z.array(z.string().min(1)),
});
export type BackupInventoryEntry = z.infer<typeof backupInventoryEntrySchema>;

/** The key a vCenter-managed VM is named by in Veeam and Rubrik: the vCenter host and the VM's managed object id. */
export function vcenterObjectKey(vcenter: string, moRef: string): string {
  return (vcenter.trim() + ':' + moRef.trim()).toLowerCase();
}

/** Inventory keys of a CI from the attributes and identity the CMDB holds. */
export function inventoryKeysOf(name: string, identity: Record<string, unknown>, attributes: Record<string, unknown>): string[] {
  const keys = new Set<string>();
  const put = (v: unknown): void => {
    if (typeof v === 'string' && v.trim() !== '') keys.add(v.trim().toLowerCase());
  };
  put(name);
  for (const k of ['instanceUuid', 'fqdn', 'serialNumber', 'systemUuid']) put(identity[k]);
  for (const k of ['fqdn', 'hostname', 'ipAddress', 'primaryIp', 'instanceUuid', 'serialNumber']) put(attributes[k]);
  const vcenter = attributes['vcenter'];
  const moRef = attributes['moRef'];
  if (typeof vcenter === 'string' && typeof moRef === 'string' && vcenter !== '' && moRef !== '') keys.add(vcenterObjectKey(vcenter, moRef));
  return [...keys];
}

/** One policy covering a CI, as the protection judgement reads it from a `backed_by` edge and its policy. */
export interface BackupCoverFacts {
  lastGoodBackupAt: string | null;
  /** The edge's RPO, else the policy's; null when neither states one. */
  rpoMinutes: number | null;
}

export interface ProtectionJudgement {
  state: ProtectionState;
  lastGoodBackupAt: string | null;
  /** Strictest RPO of the covering policies; null when none states one. */
  policyRpoMinutes: number | null;
  /** The RPO the CI is judged against: the strictest of its policies and the services it serves, else the default. */
  targetRpoMinutes: number;
  /** Whole minutes since the last good backup; null when there is none. */
  ageMinutes: number | null;
}

function minOf(values: ReadonlyArray<number | null>): number | null {
  const present = values.filter((v): v is number => v !== null && Number.isFinite(v) && v > 0);
  return present.length === 0 ? null : Math.min(...present);
}

/**
 * Judges a CI's protection from the policies covering it. Uncovered is unprotected. A covered CI is protected while its
 * newest good backup is no older than the target RPO: the strictest of the policies' RPOs and the RPOs of the business
 * services it serves (a tier-1 service that needs an hour is not met by a daily job), the default when none states one.
 * A covered CI with no good backup at all is past its RPO.
 */
export function judgeProtection(
  covers: readonly BackupCoverFacts[],
  serviceRpoMinutes: ReadonlyArray<number | null>,
  now: Date,
  defaultRpoMinutes: number = BACKUP_AWARENESS.defaultRpoMinutes,
): ProtectionJudgement {
  const policyRpoMinutes = minOf(covers.map((c) => c.rpoMinutes));
  const targetRpoMinutes = minOf([policyRpoMinutes, ...serviceRpoMinutes]) ?? defaultRpoMinutes;
  let newest: number | null = null;
  for (const c of covers) {
    const t = c.lastGoodBackupAt === null ? Number.NaN : Date.parse(c.lastGoodBackupAt);
    if (Number.isFinite(t) && (newest === null || t > newest)) newest = t;
  }
  const lastGoodBackupAt = newest === null ? null : new Date(newest).toISOString();
  const ageMinutes = newest === null ? null : Math.max(0, Math.floor((now.getTime() - newest) / (TIME.msPerSecond * TIME.secondsPerMinute)));
  const state: ProtectionState =
    covers.length === 0 ? 'unprotected' : ageMinutes === null || ageMinutes > targetRpoMinutes ? 'rpo_breached' : 'protected';
  return { state, lastGoodBackupAt, policyRpoMinutes, targetRpoMinutes, ageMinutes };
}

/** Whether a Commvault cover is application-aware for databases: one of its agents is a database agent. */
export function coversDatabases(agents: readonly string[]): boolean {
  const known = new Set<string>(BACKUP_AWARENESS.databaseAgents.map((a) => a.toLowerCase()));
  return agents.some((a) => known.has(a.trim().toLowerCase()));
}
