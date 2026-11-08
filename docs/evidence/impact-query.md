# Impact query budget (REQ-PERF-002)

Budget: `PERF_BUDGETS.impactQuery100kP95Ms` = 1000 ms, as the p95 of `k6/impact-query.js`. That is 8 VUs for 60 s,
each running `impact(ciId, direction: upstream, maxDepth: 0) { durationMs services { service { id name } predicted }
nodes { depth } }` over a random root.

**Estate:** the scale-1 tenant `570b1953` (seed 43): 550,747 CIs and 1,321,979 relationships.

**Host:** Docker Desktop on Windows, 8 CPUs and 25 GB. The whole stack shares the machine.

## Before (2026-11-08, checkpoint 29)

Single requests:

| Root | Closure | Total | Graph |
| --- | --- | --- | --- |
| PDU | 31,355 nodes | 6.5 s | 3.3–3.6 s |
| host | 446 nodes | 3.0 s | 2.9 s |

Under 8 VUs the p95 was 2.0 s.

## What was found and changed

1. **`UNION ALL` planned badly (Memgraph).**
   - The impact Cypher joins the closure and the service hop with `UNION ALL`. Run alone, its halves took 16–560 ms;
     joined, 2.7–3.2 s, whatever the closure size.
   - The repository now runs the two halves side by side (`impactQuery().parts`).
   - A breadth-first `*BFS` rewrite was measured and rejected. It returned the same rows but took 7–12 s on the closure
     alone.
2. **Hydration on demand.**
   - The API turned every closure node into a full CI (31,355 Postgres rows for one PDU).
   - It now hydrates only the services. `ImpactNode.ci` resolves through the request's batch loader when a client
     selects it; REST hydrates explicitly.
3. **Lean node projection.**
   - Impact nodes carry `{ id, tenantId, type, tier }`, the fields the API, the BSM engine and the reconciler read.
   - Under 8 concurrent closures this cut the graph time from 1.3 s to 0.76 s.
   - `.tenantId` has to stay in the projection: without it Memgraph planned the service hop at 2.7 s instead of 66 ms.
4. **Service prediction.**
   - Live health is read only for group members and services. The 31k failed ids each take the condition anyway.
   - Members are indexed by service instead of a per-service scan.
   - The redundancy models of a service set are reused for `BSM.modelCacheMs` (30 s).
5. **GraphQL execution.** Mercurius compiles a query with graphql-jit after its first run
   (`GRAPHQL_EXECUTION.jitAfterRuns`). Under load, p95 fell from 2.18 s to 1.30 s at that step.

## After

**Single worst-case request:** PDU, 31,355 nodes, 300 services predicted down: 0.47–0.78 s total, 0.36–0.45 s in the
graph.

Under 8 VUs, with 20 roots per run:

| Roots | Validation sweep | p95 |
| --- | --- | --- |
| 2 worst PDUs (31,355 nodes each), 4 random PDUs, 8 database hosts, 6 hypervisors | off | 941 ms, 934 ms |
| the same | on (default) | 975 ms |
| `impact-budget --roots <the 2 worst PDUs>`: those plus 2 sampled widest, 4 random PDUs, 8 database hosts, 6 hypervisors | on | 874 ms |
| `impact-budget` default (2 sampled widest of 100 network-feeding PDUs, 324 and 297 nodes, plus the rest) | on | 80 ms |

The 31k-node closures belong to the PDUs of one JED rack (`dh01-a-01`). Of 100 sampled PDUs that feed network gear,
the widest closure was 324 nodes, so the default mix measures typical roots and `--roots` adds the known worst cases.

## Running it

```bash
set -a && . deploy/compose/.env && set +a
pnpm --filter @openmap/perf impact-budget [--tenant <id>] [--roots id,id]
pnpm guard
```

The CI job `perf` (`.github/workflows/ci.yml`) replays a 110k-CI estate (seed 43, scale 0.2) and runs the same
command, then guard. It has not run yet: the repository has no CI remote (STATE.md, dependencies on Syed).
