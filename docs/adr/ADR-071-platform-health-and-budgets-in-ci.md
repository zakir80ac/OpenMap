# ADR-071 — Health and performance of the platform itself: one SLO catalogue, Platform health screen, budgets in CI

Status: Accepted · Date: 2026-11-10 · Tracker: REQ-PERF-005 · Contracts: GraphQL 1.43.0, perf results (`perf-results.ts`)

## Context

CAPABILITY-MAP.md lists "Health and performance of the platform itself — OpenTelemetry, Prometheus, budgets in CI" as a
`+` row (beyond Device42 parity). The parts existed but did not meet:

- every service served Prometheus metrics and OpenTelemetry spans, and Prometheus scraped them, but nothing in OpenMap
  read them back: an administrator had no view of the platform, and Prometheus had no alert rules;
- the stores OpenMap depends on were not observable as one picture: Memgraph Community has no metrics endpoint,
  Valkey, Meilisearch and PostgreSQL were not scraped, the outbox and the BullMQ queues had counters but no backlog;
- perf budgets were enforced by `pnpm guard` only when a result file existed. CI's e2e job wrote the
  screen-interaction and graph-render results and never ran guard on them; Lighthouse and the telemetry-fleet k6 budget
  did not run in CI at all; a measurement that silently did not run passed.

## Decision

1. **One SLO catalogue, two readers.** `packages/telemetry/src/slo.ts` defines ten indicators (scrape targets down,
   stores down, OpenBao sealed, GraphQL p95, GraphQL error share, HTTP 5xx share, event-loop delay, oldest undelivered
   outbox row, jobs waiting in a queue, age of the newest complete backup), each as PromQL with its objective and its
   alert. The API evaluates the indicators for the screen; `renderAlertRules` writes
   `deploy/compose/prometheus/rules/openmap-slo.rules.yml` (`pnpm --filter @openmap/telemetry slo:rules`), and a unit
   test fails when the committed file differs from the catalogue. Objectives come from `PLATFORM_HEALTH`,
   `PERF_BUDGETS` and `BACKUP`; the GraphQL p95 objective **is** the screen-interaction budget, so a live breach and a
   CI budget miss mean the same thing. Every OpenMap SLO is an upper bound. An indicator whose series is absent is
   "no data", never a false zero (`count(... == 0) or (0 * count(...))`).
2. **The reconciler reports the stores and the backlogs at scrape time.** It is the one service that writes to every
   store, so its `/metrics` carries `openmap_store_up{store}` and `openmap_store_probe_seconds{store}` (PostgreSQL,
   Memgraph, ClickHouse, Valkey, Meilisearch, each probe bounded by `PLATFORM_HEALTH.storeProbeTimeoutMs` so a hung
   store marks itself down instead of stalling the scrape), `openmap_outbox_pending_events` and
   `openmap_outbox_oldest_pending_age_seconds` (the partial index on undelivered rows makes this a 4 ms read on a
   2.8-million-row outbox) and `openmap_queue_jobs{queue,state}` for both BullMQ queues. One snapshot is shared by the
   gauges of a scrape. OpenBao is read from its own telemetry (`vault_core_unsealed`; a sealed OpenBao answers 503 to the
   scrape, so `up{job="openbao"}` is the fallback).
3. **`platformHealth(windowMinutes)` for administrators.** The API reads the deployment's own Prometheus over its HTTP
   API at `PROMETHEUS_URL` (local in every profile, so the air-gap profile makes no outbound call): build info, active
   targets, alerts of the `openmap-slo` group (kept by their `openmap_sli` label) and instant queries for the indicators
   and the per-target figures (request rate, p95 and 5xx share from the OpenTelemetry server histograms, event-loop
   p99, resident memory, CPU). Windows are `PLATFORM_HEALTH.windowsMinutes` (5 min, 1 h, 24 h). An unreachable
   Prometheus is reported with its error and every indicator as no data; an expected service that is not scraped is
   listed as "not scraped". Span `platform.health`, counter `openmap_platform_health_reads_total{outcome}`.
4. **Perf results are one contract.** `packages/contracts/src/perf-results.ts` parses a result file and judges it
   against `PERF_BUDGETS` (latency and sweep minutes as maxima, frame rate and Lighthouse scores as minima, the
   embedded-screen floor for analytics). `pnpm guard` and the API use the same function. The API reads the files under
   `PERF_RESULTS_DIR` (compose mounts `tools/perf/results` read-only; the repository keeps the directory, not its
   results).
5. **Budgets are enforced where they are measured.** `pnpm guard --perf-only --require-perf a,b` skips the source scan
   and fails when a named result is missing. CI: the e2e job runs Lighthouse after the e2e suite and requires
   `screen-interaction`, `graph-render` and `lighthouse`; the perf job adds the telemetry-fleet k6 budget and requires
   `impact-query` and `telemetry-fleet`; the nightly sweep requires `discovery-sweep`. The new screen is in the
   Lighthouse audit.
6. **The Platform health screen** (`/platform`, beside Settings) shows the KPIs (targets up, stores up, objectives
   met, alerts firing), the indicators against their objectives, the alerts, every target with its figures and scrape
   error, the stores, the outbox and queues, and the perf budgets with the time each was measured. It refreshes on the
   scrape interval (`PLATFORM_HEALTH.refreshMs`). Non-administrators see a notice and no data.

## Against Device42

Device42 runs as a vendor appliance whose own health is watched through its appliance management; we know of no
published service level objectives or performance budgets for it that an operator could check or a build could fail
on. OpenMap
states its objectives as data (`PLATFORM_HEALTH`, `PERF_BUDGETS`), alerts on them in production from the same
definitions and fails a pull request that misses one. That is the `+` in the capability map.

## Consequences

- Prometheus must be restarted (or reloaded) once to load `rule_files`; the openbao scrape job added in ADR-067 is
  picked up by the same restart. The reconciler must be rebuilt for the store, outbox and queue gauges; until then
  those indicators read "no data", truthfully.
- Prometheus is a dependency of the screen, not of the platform: without it the screen says so and the budgets still
  show.
- Alertmanager is not part of the stack; the rules fire in Prometheus and the screen lists them. Routing them to the
  notification channels of ADR-065 is a later decision.
- Adding an indicator means one entry in `slo.ts`, a value in the GraphQL `PlatformSliId` enum (a unit test keeps them
  equal), i18n keys, and regenerating the rule file.
