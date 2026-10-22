# Performance tests

Budgets come from `PERF_BUDGETS` in `packages/constants` and are enforced by `tools/guard` when a result file exists
under `tools/perf/results/` (CI writes them; they are not committed).

| Test | Tool | Budget | Result file |
| --- | --- | --- | --- |
| Impact query on 100k nodes | k6 `k6/impact-query.js` | p95 < 1000 ms | `results/impact-query.json` |
| Screen interaction p95 | Playwright timing in `apps/console/e2e` | p95 < 100 ms | `results/screen-interaction.json` |
| Graph rendering | Playwright frame timing on the dependency map | 60 fps | `results/graph-render.json` |
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
