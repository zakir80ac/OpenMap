# Headline metric per layer on cards and tables (REQ-CMDB-038, ADR-016)

Captured 2026-11-01 on the dev compose stack after replaying the regenerated scale-0.05 estate (seed 42, tenant
`ac9a6a65-1f19-4ecf-bf16-b3a90e42cc5c`).

## Path of a sample

1. A collector result carries `samples` (collector contract 0.2.0): `{ ci: CiRef, metric, ts, value, unit, labels }`.
   `tools/synth-estate` emits one headline sample per CI of a known layer, plus `ipam.subnet.utilisation_percent`
   for subnets and `dcim.power.watts` for PDUs (T-025).
2. The reconciler resolves each reference to a CI id (new CIs of the same result included), drops the rest and emits
   `openmap.metric.sampled` events of at most `RECONCILER.samplesPerEvent` (500) samples, pending for ClickHouse only
   (T-008). `openmap_reconciler_metric_samples_total{outcome}` counts stored and dropped samples.
3. The dispatcher inserts them into `metrics`; migration 0003's `metrics_latest_mv` keeps `metrics_latest` current
   (T-091).
4. `Ci.headlineMetric` (GraphQL 0.8.0) is served by a per-request batch loader: one `metrics_latest` IN query per
   page, in an OpenTelemetry span, counted by `openmap_clickhouse_queries_total{query="headline_metrics"}` (T-115).
5. The console shows it on every CMDB row, the CI detail header, focus-search hits and the impact panel, labelled
   through `metric.<key>` in en and ar with the contract unit, and says "No sample yet" where none exists (T-114).

## Replay

`pnpm --filter @openmap/synth-estate synth generate --seed 42 --scale 0.05`, then (compose reconciler stopped)
`pnpm --filter @openmap/reconciler replay --dir .local/estate-005 --reset`:

| Figure | Value |
| --- | --- |
| Collector results | 68 |
| CIs created | 28,203 (0 duplicate identities) |
| Relationships | 66,332 in store after 20,715 pending ones resolved |
| Metric samples stored / dropped | 28,501 / 0 |
| Outbox rows delivered | 94,637 (57 of them `openmap.metric.sampled`, 500 samples each at most) |
| Reconcile phase | 187 s (persist 150 s; the persist transaction now has a two-minute budget, `RECONCILER.persistTransactionTimeoutMs`, after Prisma's default five seconds expired on a 2,000-CI result) |
| Dispatch phase | 71 s |

## ClickHouse after the replay

| Metric | Rows | Mean | Unit |
| --- | --- | --- | --- |
| `net.device.throughput_gbps` | 16,366 | 18.93 | Gbps |
| `host.cpu.utilisation_percent` | 4,000 | 48.36 | percent |
| `app.apdex.score` | 3,491 | 0.85 | ratio |
| `os.patch.compliance_percent` | 2,000 | 80.62 | percent |
| `vm.cpu.utilisation_percent` | 1,635 | 48.70 | percent |
| `dcim.site.pue` | 349 | 1.62 | ratio |
| `storage.array.iops` | 252 | 22,096 | iops |
| `dcim.power.watts` | 202 | 2,443.5 | W |
| `ipam.subnet.utilisation_percent` | 107 | 48.38 | percent |
| `db.instance.iops` | 53 | 21,332 | iops |
| `container.cpu.utilisation_percent` | 32 | 54.56 | percent |
| `cloud.resource.load_percent` | 14 | 48.59 | percent |

`metrics_latest` holds 28,503 rows (one per CI and metric); `subnet_utilisation_daily` is fed for the first time
(107 subnets). `power_by_rack_hourly` keys on `toUUID(labels['rack_id'])`, the rack's CI id: a collector only knows
the rack's name, so PDU samples carry `labels['rack']` and the view stays empty until the reconciler resolves CI
references inside labels (follow-up noted in STATE.md). A second replay with the same figures confirmed the run.

## API

`cis(filter: {layers: [X]}, first: 50)` with `headlineMetric` for every layer, measured from a Node client on the
same host against the compose API (one ClickHouse `metrics_latest` query per page, counted by
`openmap_clickhouse_queries_total{query="headline_metrics",status="ok"}`):

| Layer | CIs | Sampled on the page | Round trip | Example |
| --- | --- | --- | --- | --- |
| dc | 349 | 50 / 50 | 72 ms (first call) | FAC-AWS-MIDDLE-EAST-BAHRAIN PUE 2 |
| network_security | 16,366 | 50 / 50 | 76 ms | NET-10-0-0-0-12 Traffic 19.39 Gbps |
| hardware | 4,000 | 50 / 50 | 36 ms | SRV-AHV-DMM-C01-01 Host load 31.8 % |
| storage | 252 | 50 / 50 | 34 ms | STO-DMM-FAB-A IOPS 18,908 |
| virtualization | 1,635 | 50 / 50 | 31 ms | VIRT-AHV-DMM-C01-01 CPU 62 % |
| cloud | 14 | 14 / 14 | 24 ms | CLOUD-APPLICATION-GATEWAY-PROD Load 46.1 % |
| os | 2,000 | 50 / 50 | 34 ms | OS-NUTANIX-AHV-10-0-AHV-DMM Patched 100 % |
| containers | 32 | 32 / 32 | 30 ms | K8S-CERT-MANAGER-CERT-MANAGE CPU 91.9 % |
| databases | 53 | 50 / 50 | 33 ms | DB-AML-AML IOPS 38,391 |
| applications | 3,491 | 50 / 50 | 33 ms | APP-AML Apdex 0.92 |
| unknown | 11 | 11 / 11 | 21 ms | UNK-ACCESS-CONTROL-2BB9 Last seen 31 d (derived from observedAt) |

The whole page including the ClickHouse hop stays well inside the 100 ms screen-interaction budget.

## Console

E2E walkthrough (T-087) on the rebuilt console and API images: `3 passed (44.7s)` in en and ar; the CMDB screen
asserts the "Headline metric" column header and a sampled row. Screenshots: `../console/cmdb-en.png`,
`../console/cmdb-ar.png` (every row shows e.g. `TRAFFIC 19.39 Gbps`), `../console/ci-detail-en.png`,
`../console/ci-detail-ar.png` (the header carries the metric as a card next to the badges; the Arabic page is RTL
with the value block mirrored). Unit tests (T-114, `CmdbView.test.tsx`): column header, label through i18n, value with
unit, "No sample yet" for a CI without a sample, in both locales. The virtualiser is mocked under jsdom, which gives
the scroll container no height.

Observation for a follow-up: the headline is per layer, so subnets and IP addresses (network_security) show device
traffic; a per-type override (subnet → utilisation) would read better and needs only a contract addition.

## Tests

| Test | Covers |
| --- | --- |
| T-005 `packages/contracts/src/contracts.test.ts` | `metricSampleSchema`, headline metric names follow the convention and are unique, a 0.1.0 result parses with `samples: []` |
| T-093/T-094 Go `contract_test.go` (node, collectors) | Go `MetricSample`/`Samples` match the emitted JSON Schema at 0.2.0 |
| T-008 `apps/reconciler/src/core/reconcile.test.ts` | samples bound to new and stored CIs, unknown dropped, events chunked at `samplesPerEvent` |
| T-091 `apps/reconciler/src/worker/dispatcher.test.ts` | `openmap.metric.sampled` → `metrics` rows; malformed events ignored; metric events skip the stream |
| T-025 `tools/synth-estate/src/synth.test.ts` | one headline sample per CI of a known layer, extras for subnets and PDUs, every sample references an emitted CI |
| T-115 `apps/api/src/api.integration.test.ts` | latest sample wins, null until sampled, days-since-seen for unknown CIs, one batched ClickHouse query per page, Prometheus counter |
| T-114 `apps/console/src/components/cmdb/CmdbView.test.tsx` | column header, label through i18n, value with unit, "no sample yet", en and ar |
| T-087 `apps/console/e2e/walkthrough.spec.ts` | the CMDB screen shows the metric column and a sampled row on the real stack, en and ar |
