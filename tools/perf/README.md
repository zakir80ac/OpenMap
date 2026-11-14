# Performance tests

Budgets come from `PERF_BUDGETS` in `packages/constants` and are enforced by `tools/guard` when a result file exists
under `tools/perf/results/` (CI writes them; they are not committed).

| Test | Tool | Budget | Result file |
| --- | --- | --- | --- |
| Impact query on 100k nodes | k6 `k6/impact-query.js` | p95 < 1000 ms | `results/impact-query.json` |
| Availability report, yearly roll-up of 300 services (REQ-BSM-008) | k6 `k6/availability-report.js` | p95 < 1000 ms | `results/availability-report.json` |
| Screen interaction p95 | Playwright `apps/console/e2e/perf.spec.ts` (T-089) | p95 < 100 ms | `results/screen-interaction.json` |
| Graph rendering | Playwright frame timing on the dependency map, same spec | 60 fps | `results/graph-render.json` |
| Lighthouse | `pnpm --filter @openmap/perf lighthouse` user flow over the signed-in console | performance ≥ 0.90, accessibility ≥ 0.95, best practices ≥ 0.95 | `results/lighthouse.json` (+ `lighthouse-flow.html`) |
| Discovery sweep | `pnpm --filter @openmap/perf discovery-sweep` (synth-estate replay through the reconciler, CI nightly) | 10k devices < 15 min | `results/discovery-sweep.json` |
| Telemetry fleet table page (REQ-UI-027) | `pnpm --filter @openmap/perf telemetry-budget` (k6 `k6/telemetry-fleet.js`) | p95 < 100 ms | `results/telemetry-fleet.json` |

## Budgets in CI and on the Platform health screen (REQ-PERF-005, ADR-071)

One function judges a result file against `PERF_BUDGETS`: `perfBudgetChecks` in `packages/contracts/src/perf-results.ts`.
`pnpm guard` uses it, and so does the API, which shows the results under `PERF_RESULTS_DIR` (compose mounts this
`results/` directory read-only) on the console's Platform health screen with the time each was measured.

Each CI job enforces the budgets of the measurements it runs, and fails when one of them was not written:

| CI job | Measurements | Guard step |
| --- | --- | --- |
| `e2e` | the e2e suite's perf spec (screen interaction, graph frame rate), then Lighthouse | `pnpm guard --perf-only --require-perf screen-interaction,graph-render,lighthouse` |
| `perf` | impact query and telemetry fleet table on a 110k-CI estate | `pnpm guard --perf-only --require-perf impact-query,telemetry-fleet` |
| `sweep` (nightly) | discovery sweep of about 11,000 devices | `pnpm guard --perf-only --require-perf discovery-sweep` |

`--perf-only` skips the source scan (the `verify` job runs it); `--require-perf` turns a measurement that silently did
not run into a failure. In production the same objectives are live: the GraphQL p95 alert in
`deploy/compose/prometheus/rules/openmap-slo.rules.yml` fires on the screen-interaction budget.

## Impact query

With an estate loaded (the scale-1 tenant, or `synth generate --seed 43 --scale 0.2` plus `reconciler replay --reset`
for a 110k-CI one) and the compose stack up:

```bash
set -a && . deploy/compose/.env && set +a
pnpm --filter @openmap/perf impact-budget [--tenant <id>] [--roots id,id] [--vus 8] [--duration 60s]
```

The tool does four things:

- it takes the tenant with the most CIs, unless `--tenant` names one;
- it measures the upstream closures of 100 sampled PDUs that feed network gear and keeps the two widest, then adds
  random PDUs, database hosts, hypervisors and any `--roots`;
- it creates or refreshes a load-test user for the tenant through Keycloak's bootstrap administrator (a fresh
  random password each run, never stored);
- it runs `k6/impact-query.js`, whose summary writes `results/impact-query.json`.

`pnpm guard` then fails if p95 is over budget. Measurements and the changes behind them are in
`docs/evidence/impact-query.md`.

## Availability report

With the compose stack up and a token for the tenant (the synthetic tenant after `replay-history` has months of history):

```bash
API_URL=http://localhost:4000/graphql TOKEN=... GRANULARITY=year PERIODS=3 k6 run k6/availability-report.js
```

The summary writes `results/availability-report.json`; `pnpm guard` fails if p95 is over `PERF_BUDGETS.availabilityReportP95Ms`.

## Screen interaction, graph frame rate and Lighthouse

Both run against the **production build** on the configured `PUBLIC_CONSOLE_URL` with the compose stack (API and Keycloak) up:

```bash
pnpm --filter @openmap/console build && pnpm --filter @openmap/console start
pnpm --filter @openmap/console exec playwright test e2e/perf.spec.ts --project=en
pnpm --filter @openmap/perf lighthouse
```

The perf spec signs in as the realm's seeded administrator, samples click-to-paint latency on layer toggles, CMDB layer filters, the account menu and the dependency-map direction select, then zooms and pans the map for three seconds while counting frames. The Lighthouse runner drives the Chromium that Playwright installed (Puppeteer attaches over the DevTools socket, because Puppeteer cannot spawn that binary on every host), audits the sign-in screen cold and every primary screen as a navigation with the desktop preset, and lists the failing accessibility and best-practice audits per page so a budget miss names its cause. `pnpm guard` fails when any result file is over budget.

A screen that embeds a third-party application (Analytics, the Superset dashboard) is audited twice (ADR-076): `analytics` with Superset's origin blocked, held to the console floors like every screen, and `analytics+embedded` with Superset loaded, printed as `note` and judged on accessibility and best practices only, so Superset's boot time is reported on every run without deciding the build.

`--runs N` measures the whole flow N times, each pass in a fresh browser profile, and keeps each screen's median pass by performance. CI uses three passes on a quiet stack (the Discovery Node and the scheduler stopped): a shared two-core runner can move one pass's total blocking time by hundreds of milliseconds. `--only a,b` re-measures named screens and merges them into the last full sweep's results.

## Discovery sweep

With the datastores up and **no other outbox dispatcher running** (stop the compose reconciler: two dispatchers deliver
the same rows twice):

```bash
pnpm --filter @openmap/perf discovery-sweep [--seed 44] [--scale 0.25] [--out <dir>]
```

The command does three things:

- it generates the synthetic estate with a seed of its own, so the measured tenant is new;
- it replays the estate through `reconciler replay --reset`: reconciliation, the pending and dependency-mapping passes,
  and dispatch to Memgraph, ClickHouse and Meilisearch, as ADR-046 measured it;
- it times the replay and scales it to minutes per `PERF_BUDGETS.discoverySweepDevices` devices (hosts plus network
  devices).

The result goes to `results/discovery-sweep.json`. The CI `sweep` job runs it nightly, and `pnpm guard` fails over
`PERF_BUDGETS.discoverySweepMinutes`. From a Windows host, add `connect_timeout=30` to `POSTGRES_URL` (Docker Desktop's
port forwarding can be slow to open a burst of connections).
