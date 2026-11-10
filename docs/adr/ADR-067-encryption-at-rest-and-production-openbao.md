# ADR-067 — Encryption at rest: production OpenBao, Percona pg_tde, field encryption through OpenBao Transit

Status: Accepted (Syed, 2026-11-10, STATE question 18) · Tracker: REQ-SEC-011 · Supersedes nothing

## Context

REQ-SEC-011 asks for encryption at rest and in transit. In transit, the internal CA that already signs Node mTLS issues a
certificate per service. At rest, PostgreSQL has no built-in encryption. The options were Percona's `pg_tde`, volume
encryption under the data directory, or field encryption through OpenBao Transit. The choice was `pg_tde` for every
table, so the protection ships with the product on compose, Helm and air-gapped installs alike, plus Transit for the
few personal-data fields that must stay protected from anyone who can query the database and in `pg_dump` output.

Both depend on OpenBao, which ran in dev mode: in memory, root token, nothing kept across a restart. Key material for
the database cannot live there.

Facts checked on 2026-11-10: pg_tde 2.0 (Percona Distribution for PostgreSQL 17.5.3) made WAL encryption generally
available, and Percona tested its key-provider integration with OpenBao (KV v2); OpenBao's static-key auto-unseal
arrived in 2.4.0 (PKCS#11 HSM and KMIP auto-unseal exist alongside it); 2.7.2 is the current maintained release.

## Decision

Six steps, each its own commit and evidence, in this order:

1. **Production OpenBao.** OpenBao 2.7.2 in server mode: Raft storage on its own volume; auto-unseal with the static
   key seal on compose (a 32-byte key generated once into a separate volume) and PKCS#11 (HSM) or KMIP where a
   deployment has one; an init job that initialises once (recovery keys and the initial root token written to a
   protected volume, to be moved offline), enables KV v2 at `OPENBAO_MOUNT` and Transit, writes the `openmap-services`
   policy and an AppRole for the services. Services log in with AppRole (role id and secret id from files), renew by
   logging in again before the token expires, and never hold a root token. Raft snapshots join the backup set (through
   their own AppRole with only the snapshot capability), and Prometheus scrapes OpenBao's metrics, sealed state
   included.
2. **Verify pg_tde and measure.** Pin a Percona Distribution for PostgreSQL 17 image, confirm `tde_heap` and WAL
   encryption with the OpenBao key provider, and measure the k6 and replay budgets against stock PostgreSQL.
3. **Migrate to Percona PostgreSQL with every table on `tde_heap`.** Principal key in OpenBao through its own policy;
   the data moves through the REQ-INT-019 backup and restore.
4. **Field encryption** for the short list of personal-data fields (vendor contacts, asset assignees, custom fields
   marked sensitive) through Transit; those fields are not searchable or filterable.
5. **Encrypted backup files**, the archive key wrapped by Transit.
6. **ClickHouse encrypted disk**, its key from OpenBao.

## Progress

- **Step 1** (2026-11-10): done. `docs/evidence/sec-openbao-production.md`.
- **Step 2** (2026-11-10): done. `docs/evidence/sec-pgtde-verification.md`.
  - Verified on Percona Server for PostgreSQL 17.11.1 (`percona/percona-distribution-postgresql:17.11.1-4`): tables
    and WAL are encrypted; the principal key lives in OpenBao through an OpenBao Agent sidecar.
  - pg_tde reads the token file on every call to the provider, so a renewed token needs no restart.
  - A revoked token is only noticed at the agent's next renewal; the runbook restarts the agent after a revocation.
  - Cost: writes −6.8 % TPS, bulk load +52 %, no read cost measurable.
  - Step 3 accepts on `impact-budget`, k6 and a scale replay against the TDE server.

- **Step 3** (2026-11-10): done. `docs/evidence/sec-pgtde-migration.md`.
  - Compose and Helm run Percona Server for PostgreSQL 17.11.1 with pg_tde. The OpenBao Agent is a compose service
    and, on Helm, a sidecar.
  - The dev stack moved through a backup set in 1.6 min: 192 of 192 tables encrypted, row counts identical, no real
    value in plaintext in the data files or WAL.
  - Budgets on the encrypted server: impact p95 83 ms, telemetry fleet 55 ms (138k CIs), discovery sweep 6.04 min per
    10,000 devices.
  - Backups leave the `pg_tde` extension out and restore onto the target's access method.

- **Step 4** (2026-11-10): done. `docs/evidence/sec-field-encryption.md`.
  - Encrypted through Transit (`openmap-fields`): vendor contacts (name, email, phone), asset custodians and their
    audit entries, and custom fields created as `sensitive` (text only, fixed at creation).
  - The API decrypts on the way out, batched per request; writes fail without OpenBao rather than storing plaintext.
  - These fields are not filterable or sortable in the database.
  - `reconciler encrypt-fields` backfills what was written before.
  - Contracts: CI 0.12.0, GraphQL 1.40.0.

- **Step 5** (2026-11-10): done. `docs/evidence/sec-backup-encryption.md`.
  - Each set is encrypted under a fresh Transit data key (`openmap-backup`); only the wrapped key is in the manifest.
  - AES-256-CTR plus HMAC-SHA256 over the PostgreSQL archive and a tar of the ClickHouse backup.
  - `verify` checks the MACs before anything reads the plaintext.
  - The OpenBao snapshot stays sealed by OpenBao itself.
  - On the dev stack a set takes 68 s (56 s plaintext).

- **Step 6** (2026-11-10): done. `docs/evidence/sec-clickhouse-encryption.md`.
  - The default storage policy is an encrypted disk (AES-256-CTR); its key is in OpenBao (`tde/clickhouse-disk`) and
    rendered by an OpenBao Agent into a memory volume.
  - The dev stack moved through an encrypted set: rows identical, 0 plaintext hits against 18 on the old volume.
  - The sweep costs 38 % more (8.36 min per 10,000 devices against 15); read budgets are unchanged.

What remains of REQ-SEC-011 is encryption in transit (TLS between the services and to the stores).

## Consequences

- OpenBao becomes tier 0: if its keys are unavailable, PostgreSQL does not start; if they are lost, the data is lost.
  Its storage, unseal key, recovery keys and snapshots are operated as such (deploy/README.md).
- The dev root token (`openmap-dev-root`) goes away; host-side integration tests use a token the developer exports.
- Components: OpenBao 2.3 → 2.7.2; PostgreSQL → Percona Distribution for PostgreSQL 17 (step 3).
