// T-567 REQ-INT-019 (ADR-066) — the backup manifest the script writes, and freshness: the newest complete set by
// completion time, stale when there is none or it finished more than BACKUP.staleHours ago.
import { describe, expect, it } from 'vitest';
import { backupManifestSchema, backupsStale, newestComplete, type BackupManifest } from './backup.js';

const sha = 'a'.repeat(64);
const manifest = (
  name: string,
  status: BackupManifest['status'],
  completedAt: string | null,
): BackupManifest =>
  backupManifestSchema.parse({
    format: 'openmap-backup/1',
    name,
    status,
    createdAt: '2026-11-10T00:00:00.000Z',
    completedAt,
    postgres:
      status === 'complete'
        ? { file: 'postgres.dump', bytes: 10, sha256: sha, migration: '0043_firewall_object_ci_type', cis: 3 }
        : null,
    clickhouse:
      status === 'complete'
        ? { directory: 'clickhouse', database: 'openmap', bytes: 20, files: 4, sha256: sha }
        : null,
    derived: ['memgraph', 'meilisearch'],
    error: status === 'failed' ? 'pg_dump failed' : null,
  });

describe('backup manifests', () => {
  it('reads what the script writes and refuses another format or a bad checksum', () => {
    const line =
      '{"format":"openmap-backup/1","name":"itest-1","status":"complete","createdAt":"2026-11-10T08:05:02.000Z","completedAt":"2026-11-10T08:05:02.000Z","postgres":{"file":"postgres.dump","bytes":191659,"sha256":"e7177f2b8e519f7677b823e12264c6e9065876e8c26e6adb0fd68c8b741a10fe","migration":"0043_firewall_object_ci_type","cis":0},"clickhouse":{"directory":"clickhouse","database":"openmap_bk_itest","bytes":61278,"files":40,"sha256":"fe2838198f483a9ebaca0e939d11ea482784f8799c85de74e98944b7bcd35302"},"derived":["memgraph","meilisearch"],"error":null}';
    expect(backupManifestSchema.parse(JSON.parse(line)).postgres?.bytes).toBe(191_659);
    expect(backupManifestSchema.safeParse({ ...JSON.parse(line), format: 'other/1' }).success).toBe(false);
    expect(
      backupManifestSchema.safeParse({
        ...(JSON.parse(line) as object),
        postgres: { file: 'x', bytes: 1, sha256: 'nope', migration: '', cis: 0 },
      }).success,
    ).toBe(false);
  });

  it('takes the newest complete set and calls the backups stale past the window', () => {
    const sets = [
      manifest('old', 'complete', '2026-11-08T01:00:00.000Z'),
      manifest('new', 'complete', '2026-11-09T23:00:00.000Z'),
      manifest('broken', 'failed', '2026-11-10T01:00:00.000Z'),
      manifest('now', 'running', null),
    ];
    expect(newestComplete(sets)?.name).toBe('new');
    expect(backupsStale(sets, new Date('2026-11-10T12:00:00.000Z'))).toBe(false);
    expect(backupsStale(sets, new Date('2026-11-11T02:00:00.000Z'))).toBe(true);
    expect(
      backupsStale(
        [manifest('broken', 'failed', '2026-11-10T01:00:00.000Z')],
        new Date('2026-11-10T02:00:00.000Z'),
      ),
    ).toBe(true);
    expect(newestComplete([])).toBeNull();
  });
});
