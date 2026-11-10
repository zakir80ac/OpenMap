# TLS for Valkey, Memgraph, Meilisearch and OpenBao (REQ-SEC-011, ADR-068)

Captured 2026-11-10, on a scratch compose project (`-p omtls`, fresh volumes, shifted ports). The project ran the
changed `docker-compose.yml` with `.env.example` defaults. The shared stack was not touched while other work used it.

## Certificates served

`openssl s_client` from inside the compose network, after `openbao-certs` had replaced OpenBao's bootstrap pair:

| Store | Issuer | Subject | Expires |
| --- | --- | --- | --- |
| openbao:8200 | OpenMap Internal Services CA | openbao | +30 days |
| valkey:6379 | OpenMap Internal Services CA | valkey | +30 days |
| memgraph:7687 | OpenMap Internal Services CA | memgraph | +1 year (`MEMGRAPH_TLS_TTL`) |
| meilisearch:7700 | OpenMap Internal Services CA | meilisearch | +30 days |
| postgres:5432 (STARTTLS) | OpenMap Internal Services CA | postgres | +30 days |

OpenBao logged `OpenBao reload triggered` on the agent's SIGHUP.

The fresh PostgreSQL ran pg_tde with the new provider record
`{"url" : "https://openbao:8200", …, "caPath" : "/run/openmap/ca/services-ca.crt"}`.

## Clients (T-586)

`apps/reconciler/src/store-tls.integration.test.ts` uses the services' own clients, which trust the bundle through
`loadEnv()`. Result: 4 passed in 33.8 s.

| Store | Client | Over TLS | Refused |
| --- | --- | --- | --- |
| Valkey | ioredis, `rediss://` | `PING` answers `PONG` | plain `redis://`; TLS with an empty trust list |
| Memgraph | graph repository, `bolt+s://` | reads | plain `bolt://` |
| Meilisearch | search sink, `https` | writes | plain `http` |
| OpenBao | fetch, `https` | `sys/health` 200 | plain `http` (status 400 or a refused connection) |

On Docker Desktop the run needs `NODE_OPTIONS=--dns-result-order=ipv4first`, because its `::1` port forward stopped
answering this session.

## Renewal

A new certificate was forced by deleting the agent's PEM and restarting the agent. An agent restart on its own reuses
the valid certificate it finds, so it causes no renewal.

| Store | Served certificate | Container |
| --- | --- | --- |
| Valkey | changed after 30 s; wrapper logged `valkey: renewed certificate loaded` | not restarted (same `StartedAt`) |
| Meilisearch | changed after 42 s; wrapper logged `certificate … renewed: restarting` | restarted by its restart policy |

The first Valkey attempt exposed a bug: with the PEM missing for a moment, the wrapper exited and Valkey restarted.
The wrapper now keeps the current certificate when the file is missing.

## pg_tde's provider on an existing install

1. With PostgreSQL stopped, `pg_tde_change_key_provider` set the plain address back
   (`Key provider updated successfully!`).
2. PostgreSQL then refused to start: `HTTP(S) request to keyring provider "openbao" returned invalid response 400`, and
   `FATAL: failed to retrieve principal key`. An install upgraded without the move would fail the same way.
3. The tool set `https://openbao:8200` with the CA path, and PostgreSQL started healthy.
4. The online `pg_tde_change_global_key_provider_vault_v2` with the same values succeeded. A new table reported
   `pg_tde_is_encrypted = t`.
5. The online change with a CA path that does not exist failed (`HTTP(S) request to keyring provider "openbao"
   failed`): it checks the address against OpenBao before it records it.

deploy/README.md, "Moving a running install to TLS", gives the procedure.

## Unit tests and checks

| Check | Result |
| --- | --- |
| T-585 `packages/config/src/service-ca.test.ts` | 5 passed: bundle split, adds after the trusted CAs once per path, no duplicates, nothing without a path, refuses a file without a certificate |
| `docker compose config`: default, apps, air-gap, backup | valid |
| `helm lint`, `helm template` | clean |
| Rendered pods | every mount has its volume; no plain OpenBao address left |
| `sh -n` on the new and changed scripts | clean |

## Helm on kind (fresh install, `values-local.yaml`)

A fresh release went into a scratch namespace of the local kind cluster, with the images loaded from the local cache. It
found four faults:

| Fault | Effect | Fix |
| --- | --- | --- |
| OpenBao's readiness probe asked `sys/health`, which answers 501 until initialisation | the Service had no endpoint, so the init job could never reach OpenBao: install deadlock (predates ADR-068) | probe `sys/health?uninitcode=200&sealedcode=200&standbyok=true` |
| `register()` in `init.sh` took `secret-id/lookup`'s success as "already registered" | it succeeds for an unknown id too: no Helm secret id was ever registered, and every agent and service was refused (predates ADR-068) | look for `secret_id_accessor` in the lookup's JSON |
| The Percona image runs as uid 26 and cannot `chmod` a fresh root-owned volume | PostgreSQL crash loop | `own-data` init container, as Memgraph has |
| Meilisearch answers only TLS clients that send a server name, and the kubelet's HTTPS probe connects by IP | Meilisearch never ready | `curl` to `localhost` as an exec probe |

The refused logins tripped OpenBao's AppRole lockout. A locked role id gets 403 even with the right secret id for 15
minutes (`sys/locked-users`). With `register()` fixed, a fresh install never presents an unknown id.

After the fixes, every store pod was ready. From inside the cluster:

| Service | Issuer |
| --- | --- |
| tls-openbao:8200 | OpenMap OpenBao Bootstrap CA (chart-made, `<release>-openbao-tls`) |
| tls-valkey, tls-memgraph, tls-meilisearch, tls-clickhouse, tls-postgres | OpenMap Internal Services CA, each from its agent sidecar |

The apps' init containers built their bundles: `pki/cert/ca` read over TLS, verified with the chart's CA.

## The dev stack, moved

The README procedure, with one lesson. Superset and Keycloak still held connections when compose stopped PostgreSQL,
so the 10 s stop ended in a kill. `pg_tde_change_key_provider` then refused ("cluster must be shut down"), and
PostgreSQL could not recover against TLS-only OpenBao. The way out:

1. Start OpenBao for a minute on its previous, plain configuration.
2. PostgreSQL recovered: 750,355 CIs intact.
3. Stop Keycloak and Superset, then PostgreSQL cleanly.
4. Return OpenBao to TLS and run the offline change.

The README now says to stop every client first. The existing bundle ended without a newline, so `openbao-keys` glued the
bootstrap CA onto its last line (fixed: it now goes on a line of its own). Afterwards every service started on the new
images, and the provider record reads `https://openbao:8200` with the CA path.
