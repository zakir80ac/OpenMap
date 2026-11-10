# Reconciler at full scale — the scale-1 replay (REQ-CORE-013)

Date: 2026-11-07 · Requirement: REQ-CORE-013 · Decision: ADR-046 · Data: `docs/evidence/reconciler-scale.json`

## What was measured

The synthetic estate at scale 1 was replayed through the real pipeline (`pnpm --filter @openmap/reconciler replay
--reset`): every collector result reconciled into Postgres, the pending pass, the dependency-mapping pass, then the
outbox dispatched to Memgraph, ClickHouse, Meilisearch and the event stream. One serial worker ran it, with no result
concurrency.

- **Estate:** `synth generate --seed 43 --scale 1`. Seed 43 gives it its own tenant (`570b1953-…`), so the dev tenant's
  0.05 estate (seed 42) stayed as it was.
  - 550,747 CIs and 1,321,979 relationships in 119 collector results;
  - 45,030 devices: 40,000 hosts and 5,030 network devices;
  - 550,746 distinct identities, because the agent-SAM and SaaS results both report the vendor Microsoft.
- **Host:** the dev machine (Windows 11, 24 cores, 96 GB) with the compose stack on Docker Desktop. Postgres 17 had
  `shm_size` 1 GB. The replay ran on the host through the published port, with `connect_timeout=30` (see below).
- **Load:** the compose reconciler was stopped, so no second dispatcher claimed the rows. The API, BSM engine, scheduler,
  node, Superset and the local LLM stayed up.

## Budget

CLAUDE.md §0 and `PERF_BUDGETS` allow 15 minutes per sweep of 10,000 devices (`discoverySweepDevices`,
`discoverySweepMinutes`). For 45,030 devices that is 67.5 minutes end to end.

| Run | Code | Reconcile phase | Dispatch | Total | Per 10,000 devices | Budget |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| Before | `4a4173d` | 2,328 s | 2,343 s | 4,671 s (77.9 min) | 17.3 min | missed |
| After | `b124678` | 1,056 s | 2,119 s | 3,175 s (52.9 min) | **11.75 min** | **met** |

The "after" run meets the budget with one serial worker. The reconciler runs `RECONCILER.resultsConcurrency` (4)
results at once, which this replay does not use.

### Reconcile phase in detail

| Part | Before | After |
| --- | ---: | ---: |
| Candidate lookup | 1,549 s | 424 s |
| Persist | 339 s | 315 s |
| Reconcile (CPU) | 37 s | 29 s |
| Pending pass (400,514 relationships retried, all resolved) | 339 s | 247 s |
| Dependency-mapping pass (151,798 flows, 153,324 dependencies) | 44 s | 27 s |
| CIs per second over the phase | 237 | 521 |

The slowest results in the "before" run, by lookup time:
- SSH, 5 results: 323 s;
- WMI, 5 results: 304 s;
- IPMI/Redfish, 6 results: 303 s;
- vCenter, 4 results: 193 s.

## Identity outcome (both runs)

- **CIs:** 550,746 created. This is every distinct estate identity.
- **One update:** the vendor Microsoft, which two results report.
- **Conflicts:** 0.
- **Duplicate identities:** 0.
- **Pending relationships left:** 0.
- **Relationships stored:** 1,473,003.
- **Refs:** 4,284 resolved. 235 stay pending because they name no CI the estate holds:
  - 222 DHCP scopes name their server `dhcp-ryd-01.bank.local`;
  - 13 rooms name their building (`DC1`).
- **Stores:**
  - Memgraph holds 550,746 nodes;
  - ClickHouse `ci_history` holds 550,746 CIs;
  - every one of 2,025,274 outbox events was delivered, with no failures.

## What the replay found and fixed on the way

The scale-0.05 replays never reached these sizes. The scale-1 run stopped or crawled on each of these in turn:

| Symptom at scale 1 | Cause | Fix |
| --- | --- | --- |
| A 20,000-link result could not connect (P1001) | 101 lookup batches sent at once | `RECONCILER.lookupConcurrency` lanes (`d923837`) |
| "too many bind variables" (32,768) | IN lists of every CI id of a result | one `= ANY($1::uuid[])` parameter (`cb0a623`) |
| One SNMP insert ran for over 15 minutes | the code-suffix trigger regex-scanned the tenant once per colliding row | migration 0029, an index over code ranges (`d18772e`) |
| An SSH insert outlived its 2-minute transaction | the suffix search still read every earlier suffix of one base (3,358 on one OS name) | migration 0030, a per-base counter (`a5c403a`) |
| "could not resize shared memory segment" | Docker's and Kubernetes' 64 MB `/dev/shm` | `POSTGRES_SHM_SIZE` (compose) and `postgres.shmSize` (Helm), 1 GiB (`83dfebc`) |
| 10 `dhcp_scope` rows with one identity | the estate gave ten HQ floors one subnet, and reconciliation created a CI per observation within one result | the estate gives each floor its own subnet (`96721ec`); a CI reported twice in one result is one CI (`8cad55e`) |
| 9 pairs of hosts merged into one | random host MACs collide at 40,000 hosts | the estate draws identity MACs without repeats (`4a4173d`) |
| Lookup 1,549 s | an OR chain of 500 jsonb containments was planned as a sequential scan of `cis` (6 to 38 s per chunk) | migration 0031, identity tokens with one GIN array probe per batch (`b124678`) |
| Dispatch one target after another | — | the four targets run concurrently (`c0a121f`) |

From the Windows host, a cold burst of new connections through Docker Desktop's port forwarding can take longer than
Prisma's 5-second connect timeout. The replay therefore ran with `connect_timeout=30` in `POSTGRES_URL`. Services
inside the compose network do not go through that forwarding.

## Dispatch throughput and concurrent claims (REQ-CORE-020, ADR-050, 2026-11-08)

### Finding the slow target

The dispatch report now times each target per batch. A seed-45 replay at scale 0.05 (102,957 events) showed:

| Target | Time |
| --- | ---: |
| Memgraph | 53.6 s |
| ClickHouse | 21.0 s |
| Postgres claim and close | 12.4 s |
| Dispatch in total (the targets run side by side) | 67.8 s |

- **Memgraph.** Every statement over about 1.5 KB stalled for about 45 ms, whatever its row count, and a batch sent
  about 25 statements.
- **ClickHouse.** Each of a batch's six async inserts waited for a buffer flush, one after another.
- **Postgres.** The claim walked the primary key past every delivered row: 1.6 s per claim with 2.6 million delivered
  rows.

### Changes

- One pipelined graph transaction per batch.
- Large ClickHouse inserts are synchronous, and a batch's inserts run side by side.
- Leased `FOR UPDATE SKIP LOCKED` claims (migration 0035), served by partial indexes over the undelivered rows
  (migration 0036).
- A relationship that overtakes its CI stays pending.

### Seed 45, scale 0.05

| Run | Dispatch | Memgraph | ClickHouse | Postgres |
| --- | ---: | ---: | ---: | ---: |
| Before | 67.8 s | 53.6 s | 21.0 s | 12.4 s |
| Pipelined graph batch, leased claim | 38.0 s | 10.9 s | 20.5 s | 16.6 s |
| Plus synchronous large ClickHouse inserts | 27.3 s | 12.4 s | 6.9 s | 14.4 s |
| The same, two dispatchers | 35.3 s | 20.5 s | 8.1 s | 29.0 s (both loops) |

Two dispatchers were slower than one: their relationship batches overtook the CIs and waited for retries. The default
stays at one loop (`RECONCILER_DISPATCHERS`). More loops, or reconciler replicas, deliver each row exactly once
(T-489).

### The REQ-PERF-004 sweep: seed 44, scale 0.25 (`docs/evidence/discovery-sweep.json`)

The estate has 138,243 CIs and 11,254 devices. The sweep generated it and ran `replay --reset` with the compose
reconciler stopped.

| Run | Reconcile | Dispatch | Total | Per 10,000 devices | Budget (15 min) |
| --- | ---: | ---: | ---: | ---: | --- |
| Before (`51f9417`) | about 300 s | 899 s | 20.0 min | 17.77 min | missed |
| After | 341 s | **178 s** | **9.49 min** | **8.43 min** | **met** |

In the "after" run:
- **Delivered:** all 508,341 events.
- **Retried:** two transient ClickHouse failures, a timeout and a connection reset. Their rows stayed pending, and a
  later tick delivered them.
- **Stores:** Postgres and Memgraph both hold 138,242 CIs and 369,761 open relationships. ClickHouse holds 508,341
  events with 508,341 distinct ids.
- **Dispatch by target:**
  - ClickHouse 91.3 s;
  - Memgraph 52.6 s;
  - stream 26.7 s;
  - Meilisearch 8.9 s;
  - Postgres claim and close 61.3 s.

## The scale-1 replay with concurrent dispatchers (REQ-CORE-020, 2026-11-11)

The measurement REQ-CORE-020's acceptance names. The run used `.local/estate-s1b` (seed 43, scale 1, tenant
`570b1953-…`), reset first, with `replay --reset --dispatchers 2`. It ran on the encrypted, TLS-only stack (ADR-067,
ADR-068), with the compose reconciler stopped so that the dispatch was the replay's own.

| Run | Code | Reconcile phase | Dispatch | Total (wall) | Per 10,000 devices | Budget |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| One dispatcher (above) | `b124678` | 1,056 s | 2,119 s | 3,175 s (52.9 min) | 11.75 min | met |
| Two dispatchers, leased claims | `7002686` | 1,313 s | **646 s** | **2,041 s (34.0 min)** | **7.55 min** | **met** |

**Reconcile phase:** 1,313 s, of which 409 s went to resolving pending relationships (400,514 resolved, none left).
It is slower than the earlier run's 1,056 s for two reasons: TLS and pg_tde on every Postgres round trip, and the
53.8 s dependency-mapping pass (153,324 `depends_on` edges from 151,798 flows) that now runs inside it.

**Dispatch:** 646 s for 2,027,572 events, against 2,119 s before.
- Leased `FOR UPDATE SKIP LOCKED` claims (0035) and the partial undelivered indexes (0036) keep two loops from taking
  the same rows.
- The graph batch is one pipelined transaction.

| Target | Time |
| --- | ---: |
| Memgraph | 555 s |
| ClickHouse | 225 s |
| BSM | 178 s |
| Meilisearch | 60 s |

The targets overlap, because the two loops run concurrently.

**Stores afterwards:**
- Postgres and Memgraph both hold 550,746 CIs for the tenant.
- The outbox has 0 undelivered rows, with 12,374 deferred relationship events delivered on later ticks.
- ClickHouse holds 2,027,572 events and 2,027,572 distinct ids, so no row was delivered twice.

**Afterwards:** `replay-history --reset` reloaded the tenant's health history: 300 services, 3,651 outages and 7,302
events, in 16 s. The assistant evaluation on the tenant is 41 of 41 (`docs/evidence/assistant-eval.json`,
2026-11-10T21:25Z).

## Still open

- **ClickHouse under load.** It is now the slowest target at this size, and two of its inserts failed transiently
  (both retried). Watch `openmap_outbox_target_duration_seconds{target="clickhouse"}` and
  `openmap_outbox_failures_total`.
- **The 45 ms Memgraph stall** per large statement happens from the Windows host and, less often, inside the compose
  network. Pipelining hides it within a batch, but each batch still pays it once.
- **Strict cross-dispatcher ordering** is not provided. With more than one loop, a relationship can reach the graph a
  batch or more after its CI (ADR-050).
