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

## Still open

- **Dispatch is now two thirds of the run.** Its rate falls from about 1,400 to about 800 events/s as the stores grow,
  so one target dominates; it is not yet known which.
- **Concurrent-worker measurement:** the outbox claim is read-then-update, so a second dispatcher on one database
  delivers the same rows. `FOR UPDATE SKIP LOCKED` is needed before workers run in parallel (STATE, REQ-CORE-013 notes).
