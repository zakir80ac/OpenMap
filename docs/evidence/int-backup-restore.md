# Backup and restore (REQ-INT-019, ADR-066)

Captured 2026-11-10 on the dev compose stack.

## A backup of the dev stack

`docker compose -f docker-compose.yml -f docker-compose.apps.yml --profile backup run --rm backup create`

| Store      | What                                             | Size in the set      | Notes                                      |
| ---------- | ------------------------------------------------ | -------------------- | ------------------------------------------ |
| PostgreSQL | `pg_dump -Fc` of a 9.4 GB database (all schemas) | 698 MB (697,848,953) | 750,013 current CIs; migration 0043        |
| ClickHouse | native `BACKUP DATABASE openmap`                 | 1.39 GB, 1,596 files | history, metrics, events, audit copy       |
| Total      |                                                  | 2.09 GB              | 56 s end to end; `verify` of the set: 18 s |

Memgraph and Meilisearch are not in the set; `reproject` rebuilds them from PostgreSQL after a restore.

`reproject` (here from the Windows host to the published ports, slower than inside the compose network) rebuilt a tenant of 28,252 CIs and 74,343 relationships into Memgraph and Meilisearch in 68 s (`--keep`, upserting over what was there).

## Tests

| Test                                                                | What it proves                                                                                                                                                                                                                                                                                                             | Result                      |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| `packages/contracts/src/backup.test.ts` (T-567)                     | the manifest the script writes parses; another format or a bad checksum does not; the newest complete set by completion time; stale with none or past 26 hours                                                                                                                                                             | 2 passed                    |
| `apps/reconciler/src/backup.integration.test.ts` (T-568)            | on scratch PostgreSQL and ClickHouse databases (the live ones untouched): the real backup container archives a seeded tenant, the rows are deleted, `restore` verifies and brings back three CIs, a relationship and an event, `reproject` rebuilds the tenant's graph and search index; a tampered archive fails `verify` | 2 passed                    |
| `apps/api/src/backups/backups.integration.test.ts` (T-569)          | `backups` over a directory with complete, failed and running sets and a stray directory: newest first, newest complete named, fresh; administrators only; `openmap_backup_last_complete_timestamp_seconds` at scrape time                                                                                                  | 2 passed                    |
| `apps/console/src/components/settings/BackupsCard.test.tsx` (T-570) | the Backups card: freshness, every set with state, sizes, CIs, schema and failure reason; stale and unconfigured deployments; en and ar                                                                                                                                                                                    | 4 passed                    |
| `apps/console/e2e/backups.spec.ts` (T-571)                          | on the live stack: an administrator's Settings screen shows the Backups card with the set above; screenshots `settings-backups-{en,ar}.png`                                                                                                                                                                                | 3 of 3 (setup, en, ar), 8 s |
