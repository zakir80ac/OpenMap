# ADR-066 — Backup and restore: logical backups of the stores of record, derived stores rebuilt

Status: Accepted · Date: 2026-11-10 · Tracker: REQ-INT-019 · Contracts: GraphQL 1.39.0

## Context

CAPABILITY-MAP.md §9 asks for scripted logical backups of all stores. OpenMap writes to six: PostgreSQL (CIs,
relationships, assets, incidents, settings, the Keycloak and Superset schemas, the outbox), ClickHouse (CI and
relationship history, metrics, events, the audit copy), Memgraph and Meilisearch (projections of Postgres the outbox
dispatcher keeps), Valkey (queues and caches) and OpenBao (credentials). Nothing could back them up or bring them back.

## Decision

1. **Back up the stores of record; rebuild the projections.** A backup set holds PostgreSQL and ClickHouse only.
   Memgraph and Meilisearch are rebuilt from the restored PostgreSQL by the reconciler's new `reproject` (every tenant's
   current CIs and relationships into the graph in batches of `BACKUP.reprojectBatch`, CIs into the search index; health
   starts unknown and the BSM engine recomputes it). A rebuild cannot drift from the system of record, which a third and
   fourth backup could. Valkey holds only work in flight; OpenBao keeps its own snapshots (`bao operator raft snapshot`)
   in production and is out of scope here.
2. **One script, one image.** `deploy/backup/openmap-backup.sh` (`create`, `verify`, `restore`, `list`, `prune`) runs
   in `openmap/backup`, built FROM `postgres:17` so `pg_dump` and `pg_restore` match the server, with `curl` for
   ClickHouse:
   - PostgreSQL: `pg_dump --format=custom` of the whole database (application, Keycloak and Superset schemas);
     restore with `pg_restore --clean --if-exists --single-transaction`;
   - ClickHouse: its native `BACKUP DATABASE … TO File('<set>/clickhouse')` on a volume the server and the backup service
     share (`backups.allowed_path`); restore with `DROP DATABASE` and `RESTORE DATABASE … AS …`;
   - a manifest (`openmap-backup/1`): status (running, complete, failed), sizes, the archive's sha256 and one sha256
     over the ClickHouse files, the newest applied migration and the CI count. `verify` checks both checksums and that
     `pg_restore` can read the archive, and every restore verifies first. A set that fails says so in its manifest.
   - The newest `BACKUP_KEEP` complete sets are kept (default 7).
3. **Restore into other targets for drills.** `restore --postgres-url … --clickhouse-db …` brings a set back into other
   databases without touching the live ones; the integration test restores this way.
4. **Freshness is visible and alertable.** The API reads the manifests from the backup volume (read-only, `BACKUP_DIR`)
   for `backups` (administrators) and exposes `openmap_backup_last_complete_timestamp_seconds` at scrape time; the
   console's Settings screen shows whether the newest complete set is younger than `BACKUP.staleHours` (26: daily plus
   slack) and every set with its sizes, CIs, schema and failure reason.
5. **Scheduling stays with the host.** Compose runs the service on demand (`--profile backup run --rm backup`), from the
   host's cron or a systemd timer; Kubernetes runs the same image as a CronJob. The backup volume belongs on separate,
   encrypted storage in production.

## Consequences

- New image `openmap/backup` (in the air-gap bundle), compose service `backup` (profile `backup`), volume `backups`,
  ClickHouse `config.d/backups.xml`; `BACKUP_DIR` in the API's configuration; reconciler `reproject`.
- GraphQL 1.39.0 (additive): `BackupState`, `BackupSet`, `Backups`, query `backups`.
- The air-gap bundle now ships the `clickhouse` configuration directory, which the compose files already mounted.
- A restore takes the stack down for writers: stop api, scheduler, reconciler and bsm-engine, restore, run `reproject`,
  start them. The procedure is in deploy/README.md.
