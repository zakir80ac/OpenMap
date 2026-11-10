// REQ-INT-019 (ADR-066) — the manifest a backup set carries (written by deploy/backup/openmap-backup.sh) and how the API
// and the console judge the newest set: complete or not, and stale when older than BACKUP.staleHours.
import { BACKUP, TIME } from '@openmap/constants';
import { z } from 'zod';

export const BACKUP_STATUSES = ['running', 'complete', 'failed'] as const;
export type BackupStatus = (typeof BACKUP_STATUSES)[number];

const SHA256 = /^[a-f0-9]{64}$/u;

export const backupManifestSchema = z.object({
  format: z.literal(BACKUP.formatVersion),
  name: z.string().min(1),
  status: z.enum(BACKUP_STATUSES),
  createdAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
  postgres: z
    .object({
      file: z.string().min(1),
      bytes: z.number().int().min(0),
      sha256: z.string().regex(SHA256),
      /** The newest applied Prisma migration, so a restore knows which schema it brings back. */
      migration: z.string(),
      /** Current CIs at backup time, a quick check after a restore. */
      cis: z.number().int().min(0),
    })
    .nullable(),
  clickhouse: z
    .object({
      directory: z.string().min(1),
      database: z.string().min(1),
      bytes: z.number().int().min(0),
      files: z.number().int().min(0),
      /** sha256 of the sorted per-file checksum list, so one value vouches for the whole directory. */
      sha256: z.string().regex(SHA256),
    })
    .nullable(),
  /** REQ-SEC-011 (ADR-067): OpenBao's Raft snapshot, when the backup service has its AppRole; absent in older sets. */
  openbao: z
    .object({ file: z.string().min(1), bytes: z.number().int().min(0), sha256: z.string().regex(SHA256) })
    .nullable()
    .default(null),
  /** Stores rebuilt from Postgres after a restore instead of being backed up. */
  derived: z.array(z.string()),
  error: z.string().nullable(),
});
export type BackupManifest = z.infer<typeof backupManifestSchema>;

/** The newest complete set, by completion time. */
export function newestComplete(manifests: readonly BackupManifest[]): BackupManifest | null {
  let best: BackupManifest | null = null;
  for (const m of manifests) {
    if (m.status !== 'complete' || m.completedAt === null) continue;
    if (best === null || (best.completedAt ?? '') < m.completedAt) best = m;
  }
  return best;
}

/** True when there is no complete set, or the newest finished more than BACKUP.staleHours ago. */
export function backupsStale(manifests: readonly BackupManifest[], now: Date): boolean {
  const newest = newestComplete(manifests);
  if (newest === null || newest.completedAt === null) return true;
  return now.getTime() - Date.parse(newest.completedAt) > BACKUP.staleHours * TIME.msPerHour;
}
