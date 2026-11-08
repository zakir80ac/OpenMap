# ADR-050 — Outbox claims and dispatch throughput

Status: Accepted (REQ-CORE-020, 2026-11-08) · Date: 2026-11-08 · Tracker: REQ-CORE-020, REQ-PERF-004 · Follows: ADR-046

## Context

- **Two dispatchers delivered the same rows.** `dispatchOnce` read a batch of undelivered outbox rows, delivered them and
  then closed them. Two dispatchers on one database, such as the compose reconciler and a local replay, both delivered
  the rows they had read.
- **Dispatch set the sweep's pace.** The REQ-PERF-004 sweep (seed 44, scale 0.25) measured 17.77 minutes per 10,000
  devices against a 15-minute budget. Dispatch took 899 s of the 20-minute run.
- **Memgraph was the slowest target.** Per-target timing on a seed-45 replay at scale 0.05 (102,957 events) put
  Memgraph at 53.6 s of a 67.8 s dispatch, ClickHouse at 21.0 s and Postgres bookkeeping at 12.4 s. The targets already
  ran side by side.
  - Each Memgraph statement whose payload is over about 1.5 KB cost about 45 ms, whatever its row count: 5 rows or 437
    rows took the same time. Turning off Nagle's algorithm on the client did not change this. The stall is on the server
    or the Docker network path; inside the compose network it was 5–15 ms with the same spikes.
  - A batch sent one CI upsert, one label statement per CI type and one statement per relationship type. Each statement
    ran in its own session and transaction, about 25 statements per batch.
- **ClickHouse waited on itself.** Six inserts per batch ran one after another. Each was an async insert with
  `wait_for_async_insert`, so each waited for the server's buffer flush, up to `async_insert_busy_timeout_max_ms` (200 ms).

## Decision

1. **Leased claims (migration 0035).**
   - A dispatcher claims up to `RECONCILER.outboxBatchSize` rows with one `UPDATE … FROM (SELECT … ORDER BY sequence
     LIMIT n FOR UPDATE SKIP LOCKED)`. It sets `claimedBy` to its id and `claimedUntil` to now plus
     `RECONCILER.outboxClaimLeaseMs` (5 minutes).
   - A row is claimable while it is undelivered and its lease is absent or past. A dispatcher that dies releases its
     rows when the lease runs out.
   - Closing a batch matches `claimedBy`, so a dispatcher whose lease ran out cannot close rows another has taken. Closing
     clears the claim.
   - Rows that share what is left to deliver close in one statement per group, instead of one statement per row.
   - Two partial indexes over the undelivered rows (migration 0036) serve the claim: on `sequence`, and on `tenantId`
     and `sequence`. Without them the claim walked the primary key from the first row ever written. With 2.6 million
     delivered rows each claim took 1.6 s, and the first scale-0.25 sweep spent 349 s of its dispatch in claims. With
     them a claim takes 1–2 ms.
   - The `outbox-record` contract (0.10.0) is unchanged. The lease is the dispatcher's own bookkeeping, and no consumer
     reads it.
2. **One pipelined graph transaction per batch.**
   - `GraphRepository.applyBatch` writes in this order: CI upserts, type labels, relationships, CI retirements, then
     relationship retirements.
   - Every statement is sent before the first answer is awaited, so the batch pays one round trip instead of 25. The
     engine runs the statements in order inside the transaction, so relationships see the CIs upserted ahead of them.
   - The statements are the same Cypher on both engines; neither Memgraph's `SET n:row.label` nor MAGE's
     `merge.relationship` is used, so the Neo4j adapter keeps working.
   - Relationship retirements are batched, and each finds its edge from its source CI rather than by scanning edges.
3. **A relationship that overtakes its CI waits.**
   - A relationship whose endpoint is not in the graph is reported back (`unmatchedRelationshipIds`), instead of being
     skipped by the `MATCH`.
   - Its row keeps `memgraph` pending, with `lastError` saying why, and a later claim retries it.
   - With one dispatcher this happens only when the CI is genuinely missing. With several, the CI can still be in
     another dispatcher's transaction.
4. **ClickHouse.** A batch's inserts run side by side. An insert of `RECONCILER.clickhouseSyncInsertRows` (500) rows or
   more is synchronous. Async inserts remain for the small steady-state batches they were chosen for, and the
   acknowledgement stays durable either way.
5. **One dispatcher by default.**
   - `RECONCILER_DISPATCHERS` (default `RECONCILER.outboxDispatchers`, 1) sets how many dispatch loops a reconciler
     runs. More loops, or reconciler replicas, are safe.
   - On the seed-45 replay two loops were slower than one: 30–37 s against 27 s. Relationship batches overtook their CIs
     (296 to 9,954 deferrals per run), and each retry cost Memgraph work.
   - The replay tool takes `--dispatchers N` and claims only its own tenant's rows.
   - A replay's drain no longer stops at the first tick that delivers nothing. A failed target keeps its rows pending,
     and the drain retries them after `RECONCILER.outboxIdleMs`, for up to `RECONCILER.replayStallTicks` ticks in a
     row. One ClickHouse timeout had ended a sweep with 188,000 rows undelivered.
   - A replay that leaves rows undelivered exits non-zero, so a timed sweep cannot report an incomplete run.
6. **Schema statements retry transient errors.** Memgraph creates an index only with the storage to itself. A replay
   started while the API was reading failed at its first statement, because auto-commit statements get no driver
   retry. `ensureSchema` now retries a transient error up to `GRAPH.schemaRetryAttempts` times.

## Results

Seed 45, scale 0.05: 28,252 CIs and 102,706 outbox events. The replay ran on the host, with the compose reconciler
stopped.

| Change | Dispatch | Memgraph | ClickHouse | Postgres |
| --- | ---: | ---: | ---: | ---: |
| Before | 67.8 s | 53.6 s | 21.0 s | 12.4 s |
| Pipelined graph batch, leased claim | 38.0 s | 10.9 s | 20.5 s | 16.6 s |
| Plus synchronous large ClickHouse inserts | **27.3 s** | 12.4 s | 6.9 s | 14.4 s |
| The same, two dispatchers | 35.3 s | 20.5 s | 8.1 s | 29.0 s (both loops) |

After each run the tenant had the same counts in Memgraph and Postgres: 28,252 CIs and 74,343 open relationships.
ClickHouse held 102,706 events with 102,706 distinct ids. The sweep result is in `docs/evidence/reconciler-scale.md`.

## Consequences

- Concurrent dispatchers no longer double-deliver (T-489). The replay no longer needs the compose reconciler stopped
  for correctness. It still needs it stopped for a clean measurement, because the reconciler would take a share of the
  rows.
- The graph target's cost is per batch, not per statement, so batch size is now the lever for the graph.
- Postgres bookkeeping (the claim and close) is now the largest target after Memgraph.
- Ordering across dispatchers is eventual, not strict. A relationship can reach the graph a batch or more after its CI,
  never before it.
- A relationship whose endpoint never reaches the graph stays pending and is retried on every claim, with `lastError`
  set. The `openmap_outbox_deferred_total` metric counts these retries.
