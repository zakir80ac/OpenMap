# Performance tests

Budgets come from `PERF_BUDGETS` in `packages/constants` and are enforced by `tools/guard` when a result file exists
under `tools/perf/results/` (CI writes them; they are not committed).

| Test | Tool | Budget | Result file |
| --- | --- | --- | --- |
| Impact query on 100k nodes | k6 `k6/impact-query.js` | p95 < 1000 ms | `results/impact-query.json` |
| Screen interaction p95 | Playwright `apps/console/e2e/perf.spec.ts` (T-089) | p95 < 100 ms | `results/screen-interaction.json` |
| Graph rendering | Playwright frame timing on the dependency map, same spec | 60 fps | `results/graph-render.json` |
| Lighthouse | `pnpm --filter @openmap/perf lighthouse` user flow over the signed-in console | performance ≥ 0.90, accessibility ≥ 0.95, best practices ≥ 0.95 | `results/lighthouse.json` (+ `lighthouse-flow.html`) |
| Discovery sweep | synth-estate replay through the scheduler and reconciler | 10k devices < 15 min | `results/discovery-sweep.json` |

## Impact query

1. Generate and load the estate: `pnpm --filter @openmap/synth-estate exec tsx src/cli.ts generate --seed 42 --scale 1 --out ../../packages/testing/fixtures/synth` then `pnpm --filter @openmap/reconciler replay --dir ../../packages/testing/fixtures/synth --reset`.
2. Start the API and obtain a Keycloak token for the synthetic tenant.
3. Pick root ids (PDUs and database hosts are the worst cases): `SELECT id FROM cis WHERE type IN ('pdu','host') LIMIT 20`.
4. Run from this directory:

```bash
API_URL=http://localhost:4000/graphql TOKEN=... ROOT_IDS=id1,id2 k6 run k6/impact-query.js
```

The summary writes `results/impact-query.json`; `pnpm guard` then fails if p95 is over budget.

## Screen interaction, graph frame rate and Lighthouse

Both run against the **production build** on the configured `PUBLIC_CONSOLE_URL` with the compose stack (API and Keycloak) up:

```bash
pnpm --filter @openmap/console build && pnpm --filter @openmap/console start
pnpm --filter @openmap/console exec playwright test e2e/perf.spec.ts --project=en
pnpm --filter @openmap/perf lighthouse
```

The perf spec signs in as the realm's seeded administrator, samples click-to-paint latency on layer toggles, CMDB layer filters, the account menu and the dependency-map direction select, then zooms and pans the map for three seconds while counting frames. The Lighthouse runner drives the Chromium that Playwright installed (Puppeteer attaches over the DevTools socket, because Puppeteer cannot spawn that binary on every host), audits the sign-in screen cold and every primary screen as a navigation with the desktop preset, and lists the failing accessibility and best-practice audits per page so a budget miss names its cause. `pnpm guard` fails when any result file is over budget.
