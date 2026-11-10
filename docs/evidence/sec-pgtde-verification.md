# pg_tde verification and cost (REQ-SEC-011 step 2, ADR-067)

Captured 2026-11-10 on the dev compose stack, profile `tde-lab`. Two servers run side by side on the same host, with the
same settings (`shared_buffers` 128 MB, `max_wal_size` 1 GB, `synchronous_commit` on):

- **Stock:** `postgres`, PostgreSQL 17.11 (Debian, PGDG). This is the server OpenMap runs on today.
- **TDE:** `postgres-tde`, Percona Server for PostgreSQL 17.11.1 (`percona/percona-distribution-postgresql:17.11.1-4`).
  It runs with `shared_preload_libraries=pg_tde`.

## How the TDE server is set up

`deploy/compose/postgres/tde/00-pg-tde.sh` runs on first start. It:

- creates the extension in `template1` and in the application database;
- adds the global key provider `openbao`: KV v2 mount `tde`, token read from `/run/pgtde/token`;
- creates the principal key `openmap-principal-1` and makes it the default key and the server (WAL) key;
- sets `pg_tde.wal_encrypt = on` and `default_table_access_method = tde_heap`.

`pgtde-agent` (OpenBao Agent 2.7.2, `deploy/compose/openbao/agent-pgtde.hcl`):

- logs in with the `pg-tde` AppRole (policy `pg-tde`: the `tde` mount only; 1 h tokens, 24 h maximum);
- keeps the token in the file the key provider reads, mode 0440, as the image's postgres user (uid 26).

PostgreSQL never holds a long-lived token.

## Encryption at rest

The canary row `OPENMAP-PLAINTEXT-CANARY-7731` was written, then a `CHECKPOINT`. Both data directories were then
searched for it with `grep -r` over `base/` and `pg_wal/`.

| Check | Stock | TDE |
| --- | --- | --- |
| `pg_tde_is_encrypted('tde_probe')` | (no pg_tde) | `t` |
| `SHOW pg_tde.wal_encrypt` | (no pg_tde) | `on` |
| `SHOW default_table_access_method` | `heap` | `tde_heap` |
| Canary found in the table's files | yes (`base/16384/160915`) | no |
| Canary found in the WAL | yes (`pg_wal/000000010000003700000080`) | no |

The stock column is the control: the same search finds the plaintext when nothing encrypts it.

## Token rotation and key rotation

1. **Token revoked** (`bao token revoke` on the agent's token):
   - Reads went on: the keys were already in memory.
   - Creating a principal key failed with `Invalid HTTP response from keyring provider "openbao": 403`.
   - The agent did not notice the revocation by itself; it would have at its next renewal.
   - Runbook: after revoking the token, restart the agent.
2. **Agent restarted:**
   - The agent logged in again within a second and wrote a new token.
   - Without restarting PostgreSQL, `openmap-principal-2` was created and set as the default key and the server key.
   - pg_tde reads the token file on every call to the provider.
3. **PostgreSQL restarted:**
   - It started with the server key `openmap-principal-2`, fetched from OpenBao.
   - The canary table read back, still encrypted, and WAL encryption was on.

**Found and fixed: the agent could not log in after `openbao-init` re-ran.**

- `openbao-init` runs every time an application container starts, and it re-owned the pg-tde AppRole files to its
  default uid (100), not to the agent's uid (26).
- After that, the agent failed with `no known role ID`.
- Fix: the compose file passes `PGTDE_AGENT_UID=26`, and the script's default is now 26.

## Cost

The measurement used `pgbench`, scale 50 (5 M accounts, 755 MB), on both servers. Each server got a fresh `bench_lab`
database: on the TDE server every table in it is `tde_heap` (`pg_tde_is_encrypted('pgbench_accounts')` = `t`). The
runs used 8 clients and 4 threads, 60 s per mode, and were repeated in reverse order to show the noise.

| Workload | Stock, run 1 | Stock, run 2 | TDE, run 1 | TDE, run 2 | TDE against stock (mean) |
| --- | --- | --- | --- | --- | --- |
| `pgbench -i` load | 2.8 s | 2.7 s | 3.6 s | 4.8 s | +52 % (1.5 s on 755 MB) |
| TPC-B read-write, TPS | 2,969 | 3,238 | 2,923 | 2,863 | −6.8 % |
| TPC-B average latency | 2.70 ms | 2.47 ms | 2.74 ms | 2.79 ms | +6.9 % |
| Select-only, TPS | 37,413 | 40,750 | 42,795 | 42,846 | no cost measurable |

How to read it:

- **Writes cost about 7 %, and a bulk load about half again.** Encryption runs when a page or a WAL record is
  written.
- **Reads show no cost.** The working set (755 MB) is larger than `shared_buffers` (128 MB), so pages are decrypted as
  they come in from the OS cache, and that cost is within the noise.
- **The stock numbers have a load the TDE numbers do not.** The stock server also holds the 9.4 GB dev database and
  serves the running stack, so the gap is, if anything, overstated.
- **Not yet proven against OpenMap's budgets.** Some budgets have less headroom than 7 %. Impact p95 is 874–975 ms
  against 1,000 ms, though most of that is graph time, and the service hydration it does in PostgreSQL is reads
  (`impact-query.md`). The replay's write path would take the write cost.
- **Step 3's acceptance test:** re-run `impact-budget`, the k6 suite and a scale replay on the TDE server, before the
  default changes.
