# Health and performance of the platform itself (REQ-PERF-005, ADR-071)

Captured 2026-11-10 (19:00 UTC) on the dev compose stack (Prometheus 3.4.1), from the Windows host. The running
containers predate this change: the API, reconciler and Prometheus were not rebuilt or restarted, so the figures below
come from the new code run on the host against the live Prometheus and stores.

## `platformHealth` against the live Prometheus

`PlatformHealthService.read(window)` with `PROMETHEUS_URL` at the stack's Prometheus and `PERF_RESULTS_DIR` at
`docs/evidence/perf` (the committed results). One read issues about 25 Prometheus calls in parallel; it took 74 ms (5 min),
25 ms (1 h) and 173 ms (24 h) from the host.

Scrape targets, 5-minute window (all up; ClickHouse and the OpenTelemetry collector expose no HTTP server histograms):

| Service | Job | Requests/s | p95 | 5xx | Event loop p99 | Memory | CPU cores | Scrape |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| api | openmap-services | 0.45 | 819 ms | 0 % | 41.1 ms | 750 MiB | 0.055 | 98.5 ms |
| bsm-engine | openmap-services | 0.056 | 4.8 ms | 0 % | 29.9 ms | 254 MiB | 0.015 | 20.2 ms |
| reconciler | openmap-services | 0.056 | 4.8 ms | 0 % | 26.2 ms | 248 MiB | 0.012 | 5.0 ms |
| scheduler | openmap-services | 0.30 | 19.6 ms | 0 % | 24.6 ms | 156 MiB | 0.009 | 6.0 ms |
| clickhouse | clickhouse | – | – | – | – | – | – | 53.6 ms |
| otel-collector | otel-collector | – | – | – | – | – | – | 23.6 ms |

Over 24 hours the API served 1.68 requests/s with an HTTP p95 of 93.9 ms; the scheduler's 5xx share was 0.61 %.

SLO indicators:

| Indicator | Objective | 5 min | 1 h | 24 h |
| --- | --- | --- | --- | --- |
| Scrape targets down | 0 | 0, met | 0, met | 0, met |
| Stores down | 0 | no data¹ | no data¹ | no data¹ |
| OpenBao sealed | 0 | no data² | no data² | no data² |
| GraphQL p95 | 100 ms | 1.39 s, **breached** | 1.89 s, **breached** | 92.4 ms, met |
| GraphQL errors | 1 % | 0 %, met | 1.14 %, **breached** | 0.05 %, met |
| HTTP 5xx | 1 % | 0 %, met | 0 %, met | 0.10 %, met |
| Event-loop delay p99 | 200 ms | 11.5 ms, met | 11.5 ms, met | 11.5 ms, met |
| Oldest undelivered outbox row | 60 s | no data¹ | no data¹ | no data¹ |
| Jobs waiting in a queue | 5,000 | no data¹ | no data¹ | no data¹ |
| Newest complete backup age | 26 h | 5.4 h, met | 5.4 h, met | 5.4 h, met |

¹ The store, outbox and queue gauges are served by the new reconciler code; the running reconciler predates it. Until
it is rebuilt these indicators say "no data". A first version said "0, met" here (`count(... == 0) or vector(0)`
answers 0 when the series is absent); the expressions now use `or (0 * count(...))`, which is no data in that case.
² The `openbao` scrape job (ADR-067) is in `prometheus.yml` but the running Prometheus was started before it.

The GraphQL breaches are real and are what the indicator exists to show: the last hour had little traffic (about 90
operations), dominated by first loads on the 750k-CI tenant: `NetworkTopology` p95 4 s and `Racks` 3.6 s, and one
failed `RemoveSite` (1.1 % of the hour's operations). Over the day the platform is within both objectives.

Perf budgets: the committed results give 53 checks (screen interaction 33.7 ms ≤ 100 ms; graph render 60.2 fps ≥ 60;
Lighthouse performance, accessibility and best practices on 17 screens), all within budget, none unreadable. No alert
is firing (the rules are not loaded yet; see below).

## Reconciler gauges at scrape time

One scrape of `registerPlatformGauges` against the compose stores:

```
openmap_store_up{store="postgres"} 1
openmap_store_up{store="memgraph"} 1
openmap_store_up{store="clickhouse"} 1
openmap_store_up{store="valkey"} 1
openmap_store_up{store="meilisearch"} 1
openmap_store_probe_seconds{store="postgres"} 0.0206
openmap_store_probe_seconds{store="memgraph"} 0.0293
openmap_store_probe_seconds{store="clickhouse"} 0.0242
openmap_store_probe_seconds{store="valkey"} 0.0126
openmap_store_probe_seconds{store="meilisearch"} 0.0151
openmap_outbox_pending_events 0
openmap_outbox_oldest_pending_age_seconds 0
openmap_queue_jobs{queue="openmap-collector-results",state="failed"} 1
openmap_queue_jobs{queue="openmap-events",state="failed"} 42
```

(waiting, active and delayed were 0 on both queues.) The backlog query uses the partial index on undelivered rows:
3.5 ms on an outbox of 2,799,812 rows (`EXPLAIN`: index scan on `outbox_events_undelivered_idx`).

## Alert rules

`deploy/compose/prometheus/rules/openmap-slo.rules.yml` is generated from the catalogue (10 rules, group
`openmap-slo`). `promtool check rules` in the running Prometheus container: `SUCCESS: 10 rules found`. Every indicator
in every window and every alert condition evaluates on the live Prometheus (T-616).

## Budgets in CI

| CI job | Added | Guard |
| --- | --- | --- |
| `e2e` | Lighthouse after the e2e suite (its perf spec writes screen-interaction and graph-render) | `--perf-only --require-perf screen-interaction,graph-render,lighthouse` |
| `perf` | telemetry fleet k6 budget after the impact budget | `--perf-only --require-perf impact-query,telemetry-fleet` |
| `sweep` | – | `--perf-only --require-perf discovery-sweep` |

Before this change the e2e job wrote two results and never judged them, and a measurement that did not run passed.
Locally: `pnpm guard --perf-only --require-perf impact-query` with no result fails (`[perf-missing] required perf result
impact-query was not written`); with the committed results copied in, `--require-perf
screen-interaction,graph-render,lighthouse` passes.

## Tests

| Test | What it proves | Result |
| --- | --- | --- |
| `packages/contracts/src/perf-results.test.ts` (T-610) | each result judged against its PERF_BUDGETS entry (max for latency and minutes, min for fps and Lighthouse, the embedded floor for analytics); the committed evidence results parse; a broken file says why; missing required results named | 5 passed |
| `packages/telemetry/src/slo.test.ts` (T-611) | one indicator per id, unique alerts, objectives from the budgets, windowed expressions, the committed rule file equal to the rendered catalogue | 4 passed |
| `tools/guard/src/perf.test.ts` (T-612) | within budget passes; over budget, a file that is not a result, and a required result not written are findings; `--require-perf` parsed | 4 passed |
| `apps/reconciler/src/worker/platform-gauges.integration.test.ts` (T-613) | every compose store answers its probe; a hung probe is down within the timeout; an undelivered outbox row counted with its age until delivered; queue counts per state; one snapshot per scrape | 4 passed (2 of 3 runs; the third could not open PostgreSQL from the host, the Docker Desktop forward on `::1:5432` this session) |
| `apps/api/src/platform/platform-health.service.test.ts` (T-614) | the view from Prometheus answers: joins, unscraped services, stores and OpenBao, queues, SLO status, alert filtering and order, unreachable Prometheus, window validation, perf results, GraphQL enum equal to the catalogue | 8 passed |
| `apps/api/src/platform/platform-health.integration.test.ts` (T-615) | `platformHealth` through the API module on the live Prometheus: services and ClickHouse up with figures, all indicators, a day's GraphQL p95, committed budgets judged, administrators only, odd window refused, reads counted | 4 passed |
| `apps/api/src/platform/slo-rules.integration.test.ts` (T-616) | every indicator in every window and every alert condition evaluates on Prometheus; a malformed one is refused with the reason; the watched jobs are scraped | 4 passed |
| `apps/console/src/components/platform/PlatformHealthView.test.tsx` (T-617) | the screen in en and ar: KPIs, indicators, alerts firing first, targets with figures and scrape error, stores, backlog and queues, budgets within and over, window switch, unreachable Prometheus, no perf results, non-administrators | 12 passed |
| `apps/console/e2e/platform-health.spec.ts` (T-618) | on the live stack per locale: every indicator, the services up, stores, backlog, budgets; the window switch re-reads; screenshots `platform-health-{en,ar}.png` | written, not run (needs the rebuilt API and console) |

Host-side test runs used `NODE_OPTIONS=--dns-result-order=ipv4first` and `connect_timeout=3` in `POSTGRES_URL`:
Docker Desktop's forward of 5432 on `::1` stopped answering during this session.

## To activate on the dev stack

- restart Prometheus (loads `rule_files` and the `openbao` job): `docker compose -f docker-compose.yml up -d prometheus`
  (the compose file now mounts `prometheus/rules`, so the container is recreated);
- rebuild and restart the reconciler (store, outbox and queue gauges) and the API (`platformHealth`, `PROMETHEUS_URL`,
  the perf results mount), and the console (the `/platform` screen).
