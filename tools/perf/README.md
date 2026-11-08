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
| Discovery sweep | synth-estate replay through the scheduler and reconciler | 10k devices < 15 min | `results/discovery-sweep.json` |

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
