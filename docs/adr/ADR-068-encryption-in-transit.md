# ADR-068 — Encryption in transit: an internal services CA in OpenBao, TLS to every store

Status: Accepted (follows ADR-067; REQ-SEC-011 asks for encryption in transit) · Tracker: REQ-SEC-011

## Context

ADR-067 encrypted everything at rest. On the wire, only the Discovery Node API uses mTLS, under the scheduler's own
CA. The services reach PostgreSQL, ClickHouse, Memgraph, Valkey, Meilisearch and OpenBao in plaintext over the compose
network or the Kubernetes pod network. That traffic carries credentials, OpenBao tokens and every CI.

## Decision

1. **One internal services CA, in OpenBao.**
   - `openbao-init` enables the PKI engine at `pki` and generates a root, "OpenMap Internal Services CA", valid 10
     years. The key never leaves OpenBao.
   - Role `openmap-services` issues server certificates only for the store names (the compose service names, or the
     Helm service names) and `localhost`, valid 30 days.
   - The CA certificate is written to a public volume (`service-ca`) for clients.
   - It is separate from the scheduler's Node CA, which signs client certificates for Nodes in the field.
2. **Each store's certificate is issued and renewed by the OpenBao Agent already beside it** (or a new one beside the
   stores without an agent).
   - It is rendered from a `pkiCert` template into a memory volume, and renewed before it expires.
   - The store reloads it: PostgreSQL gets a SIGHUP from the agent, through a shared process namespace; the other
     stores reload certificate files on change, or are restarted by the agent.
3. **TLS is required, not offered.**
   - PostgreSQL `hostssl` only (a plaintext connection is rejected), TLS 1.2 minimum.
   - ClickHouse HTTPS and secure native ports only.
   - Valkey `tls-port` with the plain port off.
   - Memgraph Bolt over TLS.
   - Meilisearch over HTTPS.
4. **Clients verify the server.**
   - Services: Prisma `sslmode=require&sslcert=<CA>&sslaccept=strict`.
   - Tools: libpq `sslmode=verify-full&sslrootcert=<CA>` (backups, psql); JDBC `sslmode=verify-full` (Keycloak);
     psycopg2 `sslmode=verify-full` (Superset).
   - The ClickHouse, Memgraph, Valkey and Meilisearch clients take the same CA file.
   - Configuration: `SERVICE_CA_PATH` and the per-store URLs in `packages/config`.
5. **OpenBao's own listener** cannot take a certificate from itself before it runs. A bootstrap pair is made once, and
   its CA goes into the bundle next to the internal CA, so clients trust both from one file. (As built: see below; the
   OpenBao image has no openssl.)
6. **Order of work:** PostgreSQL, ClickHouse, Valkey, Memgraph, Meilisearch, OpenBao. Each store is its own commit with
   its evidence, and each is done on compose and Helm.

## Consequences

- A store does not start without its certificate, so OpenBao is needed earlier in the start order.
- Host-side tools and tests need the CA (exported to `.local/service-ca.crt`) or `sslmode=require` without
  verification on the published ports.
- Certificate rotation is automatic; the CA itself is rotated by issuing a new root and a bundle with both.

## As built (2026-11-10)

All six stores serve TLS only, on compose and Helm. Evidence: `docs/evidence/sec-tls-postgres.md`,
`sec-tls-clickhouse.md`, `sec-tls-stores.md`.

- **Client trust.** `loadEnv()` adds the bundle at `SERVICE_CA_PATH` to Node's default CA set
  (`tls.setDefaultCACertificates`, Node 24), once per process. Every client that names no CA of its own verifies against
  it: fetch (Meilisearch, OpenBao), ioredis over `rediss://`, neo4j-driver over `bolt+s://`. No client takes a CA option,
  and no new dependency was needed.
- **Agents.** Valkey, Memgraph and Meilisearch have no agent in their images. Each gets one OpenBao Agent
  (`agent-store-tls.hcl`, AppRole `store-tls`, which may only issue from `pki/issue/openmap-services`). It runs as the
  store's user and renders certificate and key into one PEM on a memory volume shared with that store. The key is PKCS#8,
  because Meilisearch (rustls) reads no other EC key format.
- **Reload.**
  - Valkey has no certificate reload. `valkey/with-tls.sh` copies each new PEM to a new file name and points Valkey at
    it with `CONFIG SET`, without a restart.
  - Meilisearch and Memgraph read their certificate at start. `tls/restart-on-renewal.sh` stops them when it changes,
    and the restart policy starts them again. Meilisearch restarts in seconds. Memgraph reloads its snapshot, which takes
    minutes, so its certificate lasts `MEMGRAPH_TLS_TTL` (8760h). The role's `max_ttl` became `SERVICE_TLS_MAX_TTL`
    (8760h); its default lifetime stays 720h.
- **OpenBao.**
  - **Compose:** `openbao-keys` makes the bootstrap pair with `bao server -dev -dev-tls` on loopback. Its certificate
    names the container's hostname (`openbao`) and `localhost`, and its CA key is never written. `openbao-certs` then
    replaces the pair with one from the internal CA, writing `issued.pem` and copying it over `tls.pem`. It shares
    OpenBao's process namespace and sends SIGHUP, on which OpenBao reloads the listener.
  - **Helm:** a pod cannot fetch the bundle from OpenBao without already trusting OpenBao, so the chart makes the pair
    itself: `genCA` and `genSignedCert`, kept in `<release>-openbao-tls` and renewed on the first upgrade within
    `openbao.tls.renewDays`. Each pod's init container reads `pki/cert/ca` over TLS verified with that CA, and builds the
    bundle.
- **pg_tde.** The key provider's address lives in the database, and the online change checks the new address against
  OpenBao. New installs register `https://…` with the CA path. Existing installs change it with
  `pg_tde_change_key_provider` while PostgreSQL is stopped, then once more online so that the change is in the WAL
  (deploy/README.md).
