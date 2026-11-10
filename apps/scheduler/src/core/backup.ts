// REQ-INT-017 (ADR-075) — plans backup-awareness jobs: one job per backup server (a Veeam Backup & Replication server, a
// Commvault CommServe, a Rubrik cluster) the tenant registered with a vault credential reference. Each job carries the
// CMDB inventory of the CI types backups protect (VMs and hosts), each with the identity the CMDB stores and every key a
// backup product may name it by, so the collector reports `backed_by` edges from the CI the CMDB already holds.
import { randomUUID } from 'node:crypto';
import { BACKUP_AWARENESS, CONTRACT_VERSIONS } from '@openmap/constants';
import {
  BACKUP_JOB_OPTIONS,
  backupVendorSchema,
  collectorJobSchema,
  inventoryKeysOf,
  type BackupInventoryEntry,
  type BackupVendor,
  type CollectorJob,
  type CredentialType,
} from '@openmap/contracts';

/** The credential each product's API takes: OAuth2 password grant (Veeam), login (Commvault), service account (Rubrik). */
export const BACKUP_CREDENTIAL_TYPE: Record<BackupVendor, CredentialType> = {
  veeam: 'password',
  commvault: 'password',
  rubrik: 'oauth_client',
};

export interface BackupServer {
  vendor: BackupVendor;
  /** Address of the server's REST API: host, host:port or an https URL. */
  url: string;
  credentialRef: string;
}

export interface InventoryRow {
  type: string;
  name: string;
  identity: Record<string, unknown>;
  attributes: Record<string, unknown>;
}

export interface BackupPlanInput {
  tenantId: string;
  nodeId: string;
  servers: readonly BackupServer[];
  rows: readonly InventoryRow[];
  /** Extra options every job carries (simulated mode pins its CA here). */
  options?: Record<string, unknown>;
  now: string;
}

function stringIdentity(identity: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(identity)) if (typeof v === 'string' && v !== '') out[k] = v;
  return out;
}

/** The inventory entries of the rows whose type backups protect and whose identity has a value. */
export function backupInventory(rows: readonly InventoryRow[]): BackupInventoryEntry[] {
  const types = new Set<string>(BACKUP_AWARENESS.inventoryTypes);
  const out: BackupInventoryEntry[] = [];
  for (const row of rows) {
    if (!types.has(row.type)) continue;
    const identity = stringIdentity(row.identity);
    if (Object.keys(identity).length === 0) continue;
    out.push({ type: row.type as BackupInventoryEntry['type'], identity, keys: inventoryKeysOf(row.name, row.identity, row.attributes) });
  }
  return out.sort((a, b) => (a.keys[0] ?? '').localeCompare(b.keys[0] ?? ''));
}

/** Parses `vendor=value` pairs from the CLI; an unknown vendor is an error. */
export function vendorPair(text: string): { vendor: BackupVendor; value: string } {
  const at = text.indexOf('=');
  const vendor = backupVendorSchema.parse(text.slice(0, at).trim().toLowerCase());
  const value = text.slice(at + 1).trim();
  if (at < 1 || value === '') throw new Error('expected <vendor>=<value>, got ' + text);
  return { vendor, value };
}

export function planBackupJobs(input: BackupPlanInput): CollectorJob[] {
  const inventory = backupInventory(input.rows);
  return input.servers.map((server) =>
    collectorJobSchema.parse({
      jobId: randomUUID(),
      tenantId: input.tenantId,
      collectorId: BACKUP_AWARENESS.collectorId,
      nodeId: input.nodeId,
      targets: [{ kind: 'host', value: server.url, label: server.vendor }],
      credentialRef: server.credentialRef,
      credentialType: BACKUP_CREDENTIAL_TYPE[server.vendor],
      timeoutMs: BACKUP_AWARENESS.jobTimeoutMs,
      rateLimit: { concurrency: 1, requestsPerSecond: BACKUP_AWARENESS.requestsPerSecond },
      options: { ...input.options, [BACKUP_JOB_OPTIONS.vendor]: server.vendor, [BACKUP_JOB_OPTIONS.inventory]: inventory },
      scheduledAt: input.now,
      contractVersion: CONTRACT_VERSIONS.collector,
    }),
  );
}
