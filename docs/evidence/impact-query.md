# Impact query budget (REQ-PERF-002)

Budget: `PERF_BUDGETS.impactQuery100kP95Ms` = 1000 ms, as the p95 of `k6/impact-query.js`. That is 8 VUs for 60 s,
each running `impact(ciId, direction: upstream, maxDepth: 0) { durationMs services { service { id name } predicted }
nodes { depth } }` over a random root.

**Estate:** the scale-1 tenant `570b1953` (seed 43): 550,747 CIs and 1,321,979 relationships.

**Host:** Docker Desktop on Windows, 8 CPUs and 25 GB. The whole stack shares the machine.

## Before (2026-11-08, checkpoint 29)

Single requests:

| Root | Closure      | Total | Graph     |
| ---- | ------------ | ----- | --------- |
| PDU  | 31,355 nodes | 6.5 s | 3.3–3.6 s |
| host | 446 nodes    | 3.0 s | 2.9 s     |

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

| Roots                                                                                                                   | Validation sweep | p95            |
| ----------------------------------------------------------------------------------------------------------------------- | ---------------- | -------------- |
| 2 worst PDUs (31,355 nodes each), 4 random PDUs, 8 database hosts, 6 hypervisors                                        | off              | 941 ms, 934 ms |
| the same                                                                                                                | on (default)     | 975 ms         |
| `impact-budget --roots <the 2 worst PDUs>`: those plus 2 sampled widest, 4 random PDUs, 8 database hosts, 6 hypervisors | on               | 874 ms         |
| `impact-budget` default (2 sampled widest of 100 network-feeding PDUs, 324 and 297 nodes, plus the rest)                | on               | 80 ms          |

The 31k-node closures belong to the PDUs of one JED rack (`dh01-a-01`). Of 100 sampled PDUs that feed network gear,
the widest closure was 324 nodes, so the default mix measures typical roots and `--roots` adds the known worst cases.

## Breadth-first walk on Memgraph (2026-11-10)

The digital twin asks for impact in **both** directions, six hops. From a host behind a top-of-rack switch, the
path-enumerating walk grows quickly:

| Hops | Paths                      | Distinct nodes |
| ---- | -------------------------- | -------------- |
| 4    | 3.7 M                      | 12,387         |
| 5    | 26.9 M                     | 17,787         |
| 6    | transaction timeout (60 s) | —              |

The twin e2e failed on it.

The BFS rewrite rejected above (finding 1) was slow because of its plan, not because of BFS. With a labelled target,
`(x:Ci)`, Memgraph scans every CI and runs a point-to-point search to each one (`ScanAllByLabel` + `STShortestPath`). It
does that even at three hops.

`impactQueryMemgraph` leaves the target unlabelled and checks the label afterwards. That gives one single-source
`BFSExpand`. The edge filter (temporal, plus the containment gate) runs inside the expansion as a filter lambda, so a
pruned hop is never expanded. The Neo4j adapter keeps `impactQuery`.

The service hop has two halves: from the closure, and from the root itself. They run as separate parts. Joined by
`UNION ALL` they took 47 ms; on their own they take 2–3 ms each. Memgraph 3.4.0 drops the connection (and restarts) on
`collect({..., path: [n IN nodes(p) | n.id]})`, so the paths are collected as paths.

Same estate and host, three warm runs each. Node ids and depths were identical in every case the old walk finished:

| Root                     | Direction | Nodes                 | Paths (old) | BFS        |
| ------------------------ | --------- | --------------------- | ----------- | ---------- |
| PDU JED-DH01-A-01 PDU-A  | upstream  | 31,355 (300 services) | 421 ms      | 218–235 ms |
| PDU feeding network gear | upstream  | 310                   | 5 ms        | 4–5 ms     |
| host srv-dmm-sas (twin)  | both      | 16,288 (15 services)  | timeout     | 146–220 ms |
| PDU JED-DH01-A-01 PDU-A  | both      | 240,735               | —           | 2.2–2.4 s  |

## Running it

```bash
set -a && . deploy/compose/.env && set +a
pnpm --filter @openmap/perf impact-budget [--tenant <id>] [--roots id,id]
pnpm guard
```

The CI job `perf` (`.github/workflows/ci.yml`) replays a 110k-CI estate (seed 43, scale 0.2) and runs the same
command, then guard. It has not run yet: the repository has no CI remote (STATE.md, dependencies on Syed).
