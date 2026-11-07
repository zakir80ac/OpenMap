# ADR-046 — Reconciliation at full scale: identity tokens, code counters and concurrent dispatch

Status: Accepted (REQ-CORE-013, 2026-11-07) · Date: 2026-11-07 · Tracker: REQ-CORE-013, REQ-CMDB-037, REQ-QA-001

## Context

REQ-CORE-013 stayed open until a full-scale replay met the discovery budget: 10,000 devices per sweep within 15 minutes
(`PERF_BUDGETS`). Every replay until now ran at scale 0.05 (28,222 CIs). The first scale-1 replay (550,747 CIs, 45,030
devices) stopped or crawled at a new place on each attempt (`docs/evidence/reconciler-scale.md`). The causes that
needed design decisions, rather than one-line fixes, were these:

1. **Candidate lookup by jsonb containment.** The lookup found stored CIs carrying a result's globally unique values with
   `identity @> '{"serialNumber": …}'`, one term per value.
   - An OR chain of 500 terms was planned as one statement. On a 550,000-CI tenant, its row estimate made the planner
     choose a sequential scan of `cis`: 6 to 38 s per chunk.
   - One probe per term (a LATERAL subquery) avoided the scan. It paid a heap visit per term instead, and the pending
     pass grew from 339 s to over 13 minutes.
2. **Code suffixes.** Migration 0010's trigger gives a colliding short code the next free numeric suffix.
   - It counted the suffixes with a regular expression over the whole tenant, once per colliding row. One SNMP insert of
     34,237 CIs ran for over 15 minutes.
   - Restricting the search to an index range still read every earlier suffix of the same base: 3,358 hosts run one
     operating system. That insert outlived its two-minute transaction.
3. **Dispatch.** A batch reached Memgraph, ClickHouse, Meilisearch and the event stream one target after another.

## Decision

1. **Identity tokens (migration 0031).**
   - `cis."identityTokens"` holds every identity value of the row as a normalised `key=value` string: trimmed and lower
     case, as `normIdentity` writes it.
   - A trigger fills the column on every insert and every identity change, whoever writes. No writer can leave a CI the
     lookup cannot find, and the SQL needs no copy of the contract's key tables.
   - A partial GIN index covers current rows.
   - The lookup probes only the bare globally unique keys, with one array overlap per `RECONCILER.identityTokenBatch`
     (250) values. The planner overestimates an overlap about ninety times: 500 values stayed an 85 ms bitmap scan and
     5,000 became a sequential scan, so the batch stays well under the flip.
   - A scoped key (ADR-045) is probed by its own value. Its scope is still compared by the in-memory index.
   - The migration runs `ANALYZE` so the planner has the column's statistics from the start.
2. **Code counters (migrations 0029, 0030).**
   - `ci_code_counters` keeps the last suffix handed out per tenant and base. The first collision of a base seeds it from
     the stored codes, through `cis_tenant_code_pattern` (`text_pattern_ops` on current rows, a byte range
     `[<base>-, <base>.)`).
   - Every later collision takes the next number from the counter, so the n-th CI on a base costs one counter update.
     A number another writer already took is skipped.
   - A replay `--reset` clears the tenant's counters, so a reset estate numbers from 2 again.
3. **Concurrent dispatch.** One batch reaches its four targets concurrently. Each target keeps its own order and its own
   success or failure.
4. **Bounded lookups.** A result's lookup batches run through `RECONCILER.lookupConcurrency` (6) lanes. Large id sets
   travel as one array parameter (`= ANY($1::uuid[])`), not as IN lists bounded by Postgres's 32,767 bind variables.
5. **Deployment.** Postgres gets a 1 GiB `/dev/shm`. Docker and Kubernetes default to 64 MB, too little for parallel
   query workers at this scale:
   - compose: `shm_size: ${POSTGRES_SHM_SIZE:-1g}`;
   - Helm: a memory-backed `emptyDir`, `postgres.shmSize`.
6. **One CI per identity within a result.** A result that reports one CI twice yields one CI. The later observation
   merges into the CI the same result created, by the merge rules, with one created event carrying the merged CI.

## Consequences

- **Budget met.** The scale-1 replay takes 3,175 s end to end with one serial worker, against 4,671 s before. That is
  11.75 minutes per 10,000 devices, inside the 15-minute budget. Reconciliation is 1,056 s (from 2,328 s), with the
  lookup at 424 s (from 1,549 s).
- **Correct at full scale.** The replay creates exactly the estate's 550,746 distinct identities, with 0 conflicts and 0
  duplicates. Memgraph, ClickHouse and the outbox agree.
- **Storage cost.** `identityTokens` roughly repeats the identity JSON once per row, plus a GIN index on current rows.
  `ci_code_counters` holds one row per colliding base.
- **Code numbering.** A suffix is no longer reused after its CI retires: the counter only grows. Codes stay unique, as
  migration 0010's unique index requires.
- **Dispatch is now the larger half** (2,119 s). Its rate falls as the stores grow. Running several dispatchers needs
  the outbox claim made safe for concurrency first (`FOR UPDATE SKIP LOCKED`); that is tracked as its own requirement.
- **Estate fixes.** The full-scale estate no longer gives ten floors one DHCP subnet, and no longer draws one MAC for two
  hosts. The 0.05 estates are byte-identical.
