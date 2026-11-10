# OpenMap on encrypted PostgreSQL (REQ-SEC-011 step 3, ADR-067)

Captured 2026-11-10 on the dev compose stack. The stack's PostgreSQL moved from stock PostgreSQL 17.11 to Percona
Server for PostgreSQL 17.11.1 with pg_tde, through the REQ-INT-019 backup and restore.

## What changed

**Compose:**

- `postgres` is `percona/percona-distribution-postgresql:17.11.1-4`, started with `shared_preload_libraries=pg_tde`.
- Its data directory is `/data/db` on the new `postgres-tde-data` volume.
- It waits for `pgtde-agent`, which waits for `openbao-init`.
- First start runs `postgres/tde/00-pg-tde.sh`:
  - the extension in `template1` and the application database;
  - the `openbao` key provider;
  - a principal key `openmap-principal-<UTC time>`;
  - WAL encryption;
  - `tde_heap` as the default.
- The step-2 lab (`postgres-tde`, profile `tde-lab`) is gone.

**Helm:**

- The Postgres StatefulSet runs the Percona image on `/data/db`.
- It has a `pgtde-agent` sidecar (uid 26, token in a memory-backed `emptyDir`) and the same init script.
- The chart generates the `pg-tde` AppRole ids and keeps them; ids added on an upgrade are generated then. The
  OpenBao init job registers them.
- `postgres.tde.enabled` and `tokenWaitSeconds` are values; `externalApproleSecret` is used with an external vault.

**Backups:**

- Dumps leave out the `pg_tde` extension (it is server configuration).
- Restores use `--no-table-access-method`, so a set restores into stock or encrypted PostgreSQL alike.
- `restore --postgres-only` moves PostgreSQL alone.

## The move

| Step | Result |
| --- | --- |
| Writers stopped; set `pre-tde-20261110T145339` from the stock server | complete (PostgreSQL, ClickHouse, OpenBao snapshot) |
| New server started | key `openmap-principal-20261110T115458Z`, WAL encryption on |
| `restore --postgres-only` | 1.6 min |
| Row counts, before and after: `cis` 750,150; `relationships` 2,000,229; `outbox_events` 2,795,465; `asset_records` 306,828; `_prisma_migrations` 44; `keycloak.user_entity` 7; `superset.dashboards` 1 | identical |
| `pg_tde_is_encrypted` over the tables in `public`, `keycloak`, `superset` | 192 of 192 |
| Relations still on `heap` | 40 TOAST tables, all of `pg_catalog` (36) and `information_schema` (4); pg_tde leaves the catalogs alone |
| `grep -r` over `base/` and `pg_wal/` after a `CHECKPOINT`, for real values (`srv-dmm-sas`, `Microsoft 365 E3`) | 0 files |
| Database size | 9.4 GB before, 7.0 GB after (a fresh restore carries no bloat) |
| `migrate` on start | nothing to apply (PostgreSQL 44 migrations, ClickHouse, Memgraph) |

## Acceptance

These were measured on the encrypted server, on the same host, against the budgets in `PERF_BUDGETS`.

| Budget | Before (stock PostgreSQL) | On pg_tde | Budget |
| --- | --- | --- | --- |
| Impact p95, `impact-budget` (8 VUs, 20 roots, scale-1 tenant) | 80 ms (default mix, 2026-11-08) | **83 ms** | 1,000 ms |
| Telemetry fleet p95, 138k-CI tenant (`telemetry-budget --tenant 4ca6233c`) | 62 ms | **55 ms** | 100 ms |
| Telemetry fleet p95, 550k-CI tenant (the tool's default) | 130 ms (2026-11-08, over budget then) | 140–146 ms | 100 ms |
| Discovery sweep, seed 44 scale 0.25 (138k CIs, 11,254 devices), `replay --reset` through the real pipeline | 9.49 min total, 8.43 min per 10,000 devices | **6.79 min total, 6.04 min per 10,000 devices** | 15 min per 10,000 |

How to read it:

- **The scale-1 telemetry row was over budget before the move.** To check that encryption is not adding to it, the stock
  server was started again on the old volume (`postgres-data`, unchanged since the backup) behind the same API. It
  measured 131–138 ms, so the move adds nothing measurable.
- **Encryption itself does cost something**, where PostgreSQL reads pages from outside its buffers: the fleet
  snapshot's 550k-row scan takes about 310 ms on pg_tde against 200 ms on stock (warm, three runs each). That scan
  runs in the background refresh, not in a request.
- **The faster sweep is not caused by encryption.** It also reflects the dispatch work since 2026-11-08 and a freshly
  restored database without bloat. What it shows is that encryption takes no budget out of reach.

**Found and fixed:** `pg_restore` brings no planner statistics. `restore` now runs `ANALYZE` before it reports done.
