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
5. **OpenBao's own listener** cannot take a certificate from itself before it runs. `openbao-keys` creates a bootstrap
   pair with openssl once, under the same `service-ca` volume, so clients trust both from one bundle.
6. **Order of work:** PostgreSQL, ClickHouse, Valkey, Memgraph, Meilisearch, OpenBao. Each store is its own commit with
   its evidence, and each is done on compose and Helm.

## Consequences

- A store does not start without its certificate, so OpenBao is needed earlier in the start order.
- Host-side tools and tests need the CA (exported to `.local/service-ca.crt`) or `sslmode=require` without
  verification on the published ports.
- Certificate rotation is automatic; the CA itself is rotated by issuing a new root and a bundle with both.
