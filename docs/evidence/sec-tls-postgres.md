# TLS to PostgreSQL (REQ-SEC-011, ADR-068 store 1 of 6)

Captured 2026-11-10 on the dev compose stack.

## What runs

- **The internal services CA.** OpenBao's PKI engine at `pki`, root "OpenMap Internal Services CA" (EC P-256, 10
  years), created by `openbao-init`. Role `openmap-services` issues server certificates only for the store names
  (`SERVICE_TLS_NAMES`) and `localhost`, valid 30 days. The CA certificate is on the public `service-ca` volume
  (`services-ca.crt`); on Helm each pod fetches it from `pki/ca/pem` with an init container.
- **PostgreSQL's certificate.**
  - `pgtde-agent` issues it with a `pkiCert` template (`CN=postgres`, SAN `localhost`, 30 days) into its memory
    volume, one PEM for certificate and key, mode 0600, as uid 26.
  - It renews it before expiry and tells the postmaster to reload (`pkill -HUP -o -x postgres`). PostgreSQL shares
    the agent's process namespace: `pid: service:pgtde-agent` on compose, `shareProcessNamespace` on Helm.
- **TLS is required.** `ssl=on`, `ssl_min_protocol_version=TLSv1.2`. `pg_hba.conf`: `hostssl … scram-sha-256`,
  `hostnossl … reject`; the local socket (inside the container) stays trusted.
- **Clients verify the server against the CA:**
  - the services and migrations (Prisma spelling): `sslmode=require&sslcert=<CA>&sslaccept=strict`;
  - the migration runner's node-postgres client takes the same intent through `pgClientConfig`;
  - the backup tools (libpq): `sslmode=verify-full&sslrootcert=<CA>`;
  - Keycloak (JDBC): `ssl=true&sslmode=verify-full&sslrootcert=<CA>`;
  - Superset (psycopg2): `sslmode=verify-full`.
- **Host-side tools and tests** use the CA exported to `.local/services-ca.crt` (`deploy/compose/.env.example`). The
  value is quoted, because a shell sourcing the file splits an unquoted URL at `&`.

## Checks

| Check | Result |
| --- | --- |
| The certificate | `subject=CN=postgres`, issuer `OpenMap Internal Services CA`, SAN `DNS:postgres, DNS:localhost`, 30 days |
| `psql … sslmode=disable` from the compose network | `pg_hba.conf rejects connection … no encryption` |
| `psql … sslmode=verify-full sslrootcert=<CA>` | connected, `TLSv1.3` (`pg_stat_ssl`) |
| `verify-full` against another name (`openmap-postgres-1`) | refused: the certificate does not match the host name |
| Every client connection of the running stack (`pg_stat_activity` × `pg_stat_ssl`) | 18 of 18 on TLS 1.3 (the one plaintext session is a local-socket `psql` inside the container) |
| The services after the switch | API, Keycloak, Superset healthy; scheduler, reconciler, BSM engine, Node running; migrations applied |

**Found and fixed: a stale lock after the first restart.** The first restart into the shared process namespace found
a stale `postmaster.pid` naming PID 1, which is now the agent: a live process with the same uid. PostgreSQL took it
for another postmaster. The stale lock was removed once. From now on the postmaster never runs as PID 1, so this
cannot recur that way.

## Tests

| Test | Result |
| --- | --- |
| `packages/db/src/pg-config.test.ts` (T-581): the Prisma-style URL becomes a verified node-postgres TLS config without the TLS parameters; libpq spelling read too; unverified only on `accept_invalid_certs`; plaintext without `sslmode` | 3 passed |
| `apps/reconciler/src/backup.integration.test.ts`: the backup container over verified TLS, create, verify, restore | 2 passed |
| `apps/reconciler/src/worker/dispatcher.integration.test.ts` (needs the compose reconciler stopped, as it says) | 2 passed |
| API integration suite over TLS (host-side, `--no-file-parallelism`) | 110 of 111 passed. The SLA availability test timed out at 30 s inside the full run and passed alone |

**Found: the Windows host's port forwarding drops connection bursts (not TLS).** The host-side suite at first failed
with `P1001` and pool timeouts. 50 parallel new connections from the host lose about half, to PostgreSQL over TLS and
equally to ClickHouse's plaintext HTTP, through Docker Desktop's port forwarding. From inside the compose network, 50
parallel TLS connections all succeed in 315 ms. The services run inside the network and are unaffected. Host tools use
`connect_timeout=30&connection_limit=5&pool_timeout=30` (`.env.example`), and the host-side integration suites run with
`--no-file-parallelism`.
