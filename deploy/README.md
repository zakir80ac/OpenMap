# Deploying OpenMap

Three profiles ship in this directory. Every value they set mirrors a documented default in
`packages/config/src/env.ts`; nothing in application code carries a host, port or path.

| Profile | Where | Use |
| --- | --- | --- |
| Single node (compose) | `compose/docker-compose.yml` + `compose/docker-compose.apps.yml` | evaluation, labs, small estates (REQ-INT-001) |
| Air-gapped (compose) | the two files above + `compose/docker-compose.airgap.yml` and the offline bundle | sovereign sites with no egress (REQ-INT-002, REQ-INT-008) |
| Kubernetes (Helm) | `helm/openmap` | production clusters, OpenShift included (REQ-INT-003) |

## Images

Two recipes build every image from the repository root:

```bash
docker build -f deploy/docker/node-service.Dockerfile --build-arg APP=api        -t openmap/api:dev .
docker build -f deploy/docker/node-service.Dockerfile --build-arg APP=scheduler  -t openmap/scheduler:dev .
docker build -f deploy/docker/node-service.Dockerfile --build-arg APP=reconciler -t openmap/reconciler:dev .
docker build -f deploy/docker/node-service.Dockerfile --build-arg APP=bsm-engine -t openmap/bsm-engine:dev .
docker build -f deploy/docker/node.Dockerfile -t openmap/node:dev .
```

`node-service.Dockerfile` compiles the pnpm workspace once and copies only the service, its
production dependencies and the workspace packages it imports (`pnpm deploy`). `node.Dockerfile`
produces the Discovery Node and all collector binaries, statically linked on a distroless base.

## Single node

```bash
cd deploy/compose
cp .env.example .env            # edit secrets
docker compose -f docker-compose.yml -f docker-compose.apps.yml up -d --build
```

`migrate` applies the Postgres, ClickHouse and Memgraph migrations and exits; the services start
after it. The scheduler creates its CA and server certificate on first start into the `scheduler-pki`
volume (idempotent, never overwritten).

### Enrolling a Discovery Node

1. Register the Node and get its one-time token:
   `docker compose exec scheduler node dist/node-register.js --tenant <tenant uuid> --site HQ --node node-hq-01`
2. Start the Node profile with that token:
   `OPENMAP_ENROL_TOKEN=<token> OPENMAP_NODE_ID=node-hq-01 OPENMAP_SITE_CODE=HQ docker compose --profile node run --rm node enrol`
   then `docker compose --profile node up -d node`.
3. Submit a job or run a sweep from the console (`Discovery → Run discovery`); for a quick check:
   `docker compose exec scheduler node dist/job-submit.js --tenant <tenant uuid> --node node-hq-01 --collector port_scan --target 10.0.0.0/24 --kind cidr`.

Nodes only ever connect outbound to the scheduler over mTLS; no inbound port is opened on a site.

## Air-gapped

Build or mirror the images on a connected machine, export them with `docker save`, carry the
bundle across, `docker load`, then start with the air-gap overlay, which pins `pull_policy: never`
and disables every optional egress (LLM model download, analytics):

```bash
docker compose -f docker-compose.yml -f docker-compose.apps.yml -f docker-compose.airgap.yml up -d
```

## Kubernetes

The chart has no subchart dependencies, so it installs from a mirrored registry without network
access. Datastores run as in-chart StatefulSets; point `openbao.external` at an existing vault in
production and set `image.registry` to the mirror.

```bash
helm upgrade --install openmap deploy/helm/openmap \
  --namespace openmap --create-namespace \
  --set image.registry=registry.example.internal \
  --set api.publicUrl=https://openmap.example.internal \
  --set console.publicUrl=https://openmap.example.internal \
  --set keycloak.publicUrl=https://auth.example.internal \
  --set scheduler.publicHost=scheduler.example.internal
```

Migrations run as a `pre-install,pre-upgrade` hook. The scheduler is a StatefulSet with two
volumes: the discovery PKI and the evidence store. Discovery Nodes run outside the cluster, at the
sites they observe, from the `openmap/node` image or the bare binary.
