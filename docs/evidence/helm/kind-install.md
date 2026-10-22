# helm install on kind (REQ-INT-003) — 2026-10-22T14:00:54Z

## pods
NAME                                  READY   STATUS      RESTARTS   AGE
openmap-api-6f7f9dddb6-fbdfg          1/1     Running     0          2m23s
openmap-bsm-engine-6c668fd554-pbw9j   1/1     Running     0          2m23s
openmap-clickhouse-0                  1/1     Running     0          2m21s
openmap-console-75467bf545-lpzqh      1/1     Running     0          2m23s
openmap-keycloak-548446d87b-58564     1/1     Running     0          2m23s
openmap-meilisearch-0                 1/1     Running     0          2m23s
openmap-memgraph-0                    1/1     Running     0          2m23s
openmap-migrate-1-45s7k               0/1     Completed   0          2m23s
openmap-openbao-6564cc75d5-wkrck      1/1     Running     0          2m23s
openmap-postgres-0                    1/1     Running     0          2m23s
openmap-reconciler-7658678fc8-jj7kd   1/1     Running     0          2m23s
openmap-scheduler-0                   1/1     Running     0          2m23s
openmap-valkey-0                      1/1     Running     0          2m23s

## smoke
api /readyz: ready (postgres ok, memgraph ok); api /healthz 200; console /en/dashboard 200 (Dashboard · OpenMap)

## migrations job
postgres: applied [] skipped [0001_init, 0002_ci_code, 0003_pending_relationships, 0004_identity_indexes, 0005_default_tenant]
clickhouse: applied [] skipped [0001_init]
memgraph: applied [0001_schema] skipped []

## values
deploy/helm/openmap/values-local.yaml, images openmap/*:dev loaded into the node, infra images as in compose
