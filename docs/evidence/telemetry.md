# REQ-CORE-014 — OpenTelemetry spans and Prometheus metrics in every service (2026-11-01)

Every Node service starts `@openmap/telemetry` first (`instrumentation.ts`): the OpenTelemetry SDK with the ESM loader
hook and OTLP export to the compose collector, plus a plain-HTTP listener serving `/metrics`, `/healthz` and `/readyz`.
The compose Prometheus scrapes the four services by their compose names; the Helm chart probes the same ports.

## Metrics exposed on the rebuilt images

Counted from inside the compose network (`fetch('http://<service>/metrics')` from the API container), names prefixed
`openmap_` only; `process_*` and `nodejs_*` defaults are also present on every listener.

| Service | Port | OpenMap metrics |
| --- | --- | --- |
| api | 4000 | `openmap_graphql_requests_total`, `openmap_graphql_duration_seconds_{bucket,sum,count}`, `openmap_audit_entries_total`, `openmap_analytics_guest_tokens_total` |
| reconciler | 4100 | `openmap_outbox_batches_total`, `openmap_outbox_delivered_total` |
| scheduler | 4201 | `openmap_scheduler_requests_total`, `openmap_scheduler_request_duration_seconds_{bucket,sum,count}` |
| bsm-engine | 4400 | `openmap_bsm_events_total`, `openmap_bsm_recomputes_total`, `openmap_bsm_recompute_duration_seconds_{bucket,sum,count}`, `openmap_bsm_service_changes_total` |

## Prometheus targets after the configuration reload

```
openmap-services http://api:4000/metrics        up
openmap-services http://reconciler:4100/metrics up
openmap-services http://scheduler:4201/metrics  up
openmap-services http://bsm-engine:4400/metrics up
otel-collector   http://otel-collector:8889/metrics up
```

Two defects found and fixed on the way: the production images of reconciler, scheduler and bsm-engine crash-looped
because `@opentelemetry/instrumentation` (imported directly by the loader hook) was not declared in their
`package.json`, so `pnpm deploy --prod` left it out; and the running Prometheus still held the previous scrape file
(`host.docker.internal` targets) until the container was recreated. Memgraph Community has no Prometheus endpoint, so
its target was removed; ClickHouse's endpoint is enabled through `deploy/compose/clickhouse/prometheus.xml`.

Tests: T-107 (`packages/telemetry/src/telemetry.test.ts`) covers the metrics listener and `withSpan`; T-032 asserts the
API's GraphQL metrics after real operations.
