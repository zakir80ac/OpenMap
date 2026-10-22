# REQ-INT-002 — offline bundle build (2026-10-22)

Built with `deploy/airgap-bundle/build-bundle.sh dev` on the dev laptop (Docker Desktop, Windows 11). The script builds the
six application images (api, scheduler, reconciler, bsm-engine, node, console), pulls the pinned datastore images, saves
all of them into one compressed tar, copies the compose files, realm, init scripts and loader, and writes checksums.

| Item | Value |
| --- | --- |
| Images in the tar | 17 |
| Bundle size | 2.7G |
| Image tar | 2892478804 bytes |
| Files with checksums | 14 |
| Build exit code | 0 |

## images.txt

```
apache/superset:4.1.2
clickhouse/clickhouse-server:25.3
getmeili/meilisearch:v1.15
ghcr.io/ggml-org/llama.cpp:server
memgraph/memgraph-mage:3.4
openbao/openbao:2.3
openmap/api:dev
openmap/bsm-engine:dev
openmap/console:dev
openmap/node:dev
openmap/reconciler:dev
openmap/scheduler:dev
otel/opentelemetry-collector-contrib:0.128.0
postgres:17
prom/prometheus:v3.4.1
quay.io/keycloak/keycloak:26.2
valkey/valkey:8
```

## Bundle layout

```
./.env.example
./DEPLOY.md
./SHA256SUMS
./docker-compose.airgap.yml
./docker-compose.apps.yml
./docker-compose.yml
./images.txt
./keycloak/realm-openmap.json
./load-bundle.sh
./openmap-images-dev.tar.gz
./otel/collector.yaml
./postgres/init/01-schemas.sql
./prometheus/prometheus.yml
./superset/bootstrap.sh
./superset/superset_config.py
```

## SHA256SUMS

```
4f7b6531138219c6778295307662b3c96fbd34c5727a51a6b30900949a205938 *./.env.example
9baf86e4ff87dcaa94dd55152445471bc8c66d974b3ce1ffe74402346495e095 *./DEPLOY.md
dd2c26eec323e361057495052db0ada751286b51b4b16c2b24dc874dd7002d0e *./docker-compose.airgap.yml
45495dc108af2dc08766ac697301f6259df53d356829a0a4245c0d4bc8f9e917 *./docker-compose.apps.yml
0ef710f801a06f5fa65f5ff7eee884ce05bf4c17a1182e0f55d9e6ae2c099de3 *./docker-compose.yml
31df3db1e039d69d71bfd52160e6f9344176d09938bfba6fd2ee6dd81ec1e6a6 *./images.txt
d2533670c7e6f5113dfa8a90d819161e9a2f821c3ae322f9595685c30b047c3b *./keycloak/realm-openmap.json
b22fd0dd6e84c49115e7a714a09db4718eedaff2dc195e1e4a2fb5d3d3b2819f *./load-bundle.sh
8a6d4db6cfa2ea215e9bb9bed1cbc3d3964ca53cfbb65460c18f330014a27d23 *./openmap-images-dev.tar.gz
56a15c99b25db34edd5f35101bc776b5b258ee933fb16ef8a8525b3807cacd51 *./otel/collector.yaml
33575e193a7729f2500e9cb40e6c7736a9de13e44f85f0d52c23974a8b2ceb5c *./postgres/init/01-schemas.sql
a3ebe9592b35b90f32db89796b64ea1605c72394860e5366304713a018671ccb *./prometheus/prometheus.yml
e8cb944f86d54ce2da9ee77a2293407a6ff7cd5c3f6b14bc77f4555fc70e72d7 *./superset/bootstrap.sh
c1354ed0919f0c374f7b7c09a9657adba4ec2653faa5c178111d6ad51be63db5 *./superset/superset_config.py
```

Checksum verification (`sha256sum -c SHA256SUMS`) on the build host:

```
./prometheus/prometheus.yml: OK
./superset/bootstrap.sh: OK
./superset/superset_config.py: OK
```

Still outstanding for Done: `load-bundle.sh` on a clean Docker host with egress blocked, then the e2e suite against it (REQ-SEC-003).
