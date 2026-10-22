# REQ-INT-002 REQ-SEC-003 — offline bundle loaded on an isolated host with egress blocked (2026-10-22)

## Host

A Docker-in-Docker container (`docker:28-dind`, Docker 28.5.2, overlay2) on the dev laptop stands in for the clean
air-gapped host. The bundle directory is mounted read-only at `/bundle`. Before anything is loaded, every new outbound
connection is dropped inside it:

```
iptables -I FORWARD -o eth0 -m conntrack --ctstate NEW -j DROP   # containers inside the host
iptables -I OUTPUT  -o eth0 -m conntrack --ctstate NEW -j DROP   # the host itself
```

Proof the host is cut off (run inside it):

```
$ wget -T 5 -qO- https://registry-1.docker.io/v2/
wget: bad address 'registry-1.docker.io'
$ docker pull alpine:3.20
Error response from daemon: Get "https://registry-1.docker.io/v2/": dial tcp: lookup registry-1.docker.io on 192.168.65.7:53: write udp ...: operation not permitted
```

Only the published ports 3000, 4000 and 8080 are reachable from the laptop, as 13000, 14000 and 18080.

## Load

`.env` = `.env.example` plus the three public origins (`PUBLIC_CONSOLE_URL=http://localhost:13000`,
`PUBLIC_API_URL=http://localhost:14000`, `PUBLIC_KEYCLOAK_URL=http://localhost:18080`).

```
$ ./load-bundle.sh dev
verifying checksums
loading images
Loaded image: ... (17 images)
starting OpenMap (air-gapped profile)
```

15 services up (api healthy, console, scheduler, reconciler, bsm-engine, postgres, memgraph, clickhouse, valkey,
meilisearch, keycloak, openbao, superset, otel-collector, prometheus); the migrations job completed:

```
migrate-1  | postgres: applied [0001_init ... 0008_audit_cascade] skipped []
migrate-1  | clickhouse: applied [0001_init] skipped []
migrate-1  | memgraph: applied [0001_schema] skipped []
```

## Smoke (from the laptop, through the published ports)

| Check | Result |
| --- | --- |
| `GET :18080/realms/openmap` | 200, issuer `http://localhost:18080/realms/openmap` |
| `GET :14000/readyz` | `{"status":"ready","checks":[postgres ok, memgraph ok]}` |
| `GET :13000/en` | 200 after the locale redirect |

## Defects found by this test and fixed

1. **`load-bundle.sh` used `sha256sum --quiet`**, which BusyBox (Alpine hosts) does not have. Now `sha256sum -c … >/dev/null`.
2. **The realm import pinned the console client to `http://localhost:3000`.** The realm now uses
   `${CONSOLE_PUBLIC_URL:http://localhost:3000}`; a throwaway import showed Keycloak 26 substitutes plain names from
   the environment (`${env.NAME}` is rejected as an invalid URI). Compose and the chart pass `CONSOLE_PUBLIC_URL`.
3. **The console image carried `http://localhost:4000` and `http://localhost:8080` baked into the client bundle.**
   Turborepo runs tasks in strict env mode, so the build never saw the sentinel values the Dockerfile set and `loadEnv()`
   defaults were compiled in; every deployment at a non-default origin would have sent browsers to localhost. `turbo.json`
   now declares the public variables for the build task and the Dockerfile fails if the sentinels are absent.

## End-to-end suite against the air-gapped stack

