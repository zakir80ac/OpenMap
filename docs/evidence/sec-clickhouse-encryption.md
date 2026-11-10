# Encrypted ClickHouse disk (REQ-SEC-011 step 6, ADR-067)

Captured 2026-11-10 on the dev compose stack (ClickHouse 25.3; the Helm chart pins 25.8).

## Design

- **The disk.** `clickhouse/encrypted-disk.xml` adds a local disk `sealed` (`/var/lib/clickhouse/disks/sealed/`) and an
  `encrypted` disk over it (AES-256-CTR). The `default` storage policy uses the encrypted disk, so every MergeTree
  table, system logs included, writes encrypted parts without a setting of its own. Table metadata (the DDL) stays in
  plaintext.
- **The key.** `openbao-init` generates 256 random bits once into `tde/clickhouse-disk`, writes the `clickhouse-disk`
  policy (read that one path) and issues its AppRole.
- **Getting the key to ClickHouse.**
  - `clickhouse-keys` (OpenBao Agent 2.7.2, uid 101) renders the key from a template into a tmpfs volume
    (`clickhouse-key`, mode 0750).
  - `clickhouse/with-disk-key.sh`, ClickHouse's entrypoint, waits for that file, exports it as `CLICKHOUSE_DISK_KEY`
    (which the disk configuration reads), and starts the image's entrypoint.
  - Without the key, ClickHouse does not start.
- **Helm.** The same pieces: a `clickhouse-keys` sidecar with a memory `emptyDir`, a ConfigMap with the disk
  configuration, the wrapper and the agent configuration, and AppRole ids generated and kept by the chart.
  `clickhouse.encryption.enabled` and `externalApproleSecret` are values.
- **Backups.** `BACKUP` reads the encrypted parts and writes the backup to the `backups` volume. The backup script then
  tars and encrypts it (step 5). `restore --clickhouse-only` was added to move ClickHouse alone.

## The move

| Step | Result |
| --- | --- |
| Writers stopped; set `pre-chenc-20261110T161548` (encrypted) | complete |
| ClickHouse recreated on `clickhouse-tde-data` with the encrypted policy | `system.disks`: `encrypted` (`is_encrypted` 1) over `sealed`; policy `default` → `['encrypted']` |
| `restore --clickhouse-only` | 12 s |
| Rows, before and after | identical for every MergeTree table. The ReplacingMergeTree and AggregatingMergeTree tables (`ci_history` 750,420; `metrics_latest` 765,717; `layer_counts_daily` 334) were compared with `FINAL` on both sides, the old volume started read-only beside it |
| Parts | 92 active parts, 8,182,726 rows, all on disk `encrypted` |
| `grep -r` for a real CI name (`srv-dmm-sas`) | 18 files on the old volume (the control); 0 under `/var/lib/clickhouse` now |

**Found and fixed on the way:** an encrypted disk cannot wrap `default` unless that disk is declared first. A
dedicated `sealed` disk is declared instead.

## Acceptance

Measured on the stack with PostgreSQL (pg_tde) and ClickHouse both encrypted:

| Budget | Before step 6 | After | Budget |
| --- | --- | --- | --- |
| Telemetry fleet p95, 138k-CI tenant | 55 ms | **60 ms** | 100 ms |
| Impact p95 (`impact-budget`, 8 VUs) | 83 ms | **76 ms** | 1,000 ms |
| Discovery sweep, seed 44 scale 0.25, minutes per 10,000 devices | 6.04 | **8.36** (9.41 total) | 15 |
| Full backup set (encrypted) | 68 s | **67 s** | — |

The sweep is the write-heavy path, and it pays for the encryption: about 38 % more time. Most of that is in the
dispatch to ClickHouse, which writes and merges encrypted parts. The sweep stays within its budget with 44 % to spare.
The read paths are within their noise.

Playwright, full suite (en and ar) on the fully encrypted stack: 101 passed.
