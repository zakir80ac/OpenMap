# ADR-016 — Metric samples through the collector contract and the outbox; one headline metric per layer (ci 0.2.0, collector 0.2.0, event 0.2.0, GraphQL 0.8.0)

Status: Accepted · Date: 2026-11-01 · Tracker: REQ-CMDB-038

## Context

The ClickHouse `metrics` table, its two materialized views (subnet utilisation, power by rack) and the contract's
`LAYER_HEADLINE_METRIC` existed, but nothing wrote a sample: the collector result carried CIs, relationships,
evidence and errors only, the console showed no measurement on any card or row, and IPAM utilisation and DCIM
power were computed from attributes. REQ-CMDB-038 asks that every card and table shows the layer's headline metric
from ClickHouse with the unit and label from the contract. CLAUDE.md §1 rule 5 ("every cross-store write is an
event") and principle 2 of the contracts ("identity, not ids, from collectors") decide the shape.

## Decision

1. **Collector contract 0.2.0.** `CollectorResult.samples` (default `[]`): `MetricSample { ci: CiRef, metric, ts,
   value, unit, labels }`. A sample references its CI the way a relationship references an endpoint, so collectors
   never need stored ids. `metric` follows the ClickHouse convention `<domain>.<object>.<measure>[_<unit>]`
   (`METRIC_NAME_PATTERN`). The Go view (`apps/node`, `apps/collectors`) carries `Samples` with `omitempty`, so a
   0.1.0 collector's result still parses; `contract.Version` is 0.2.0 on both sides.
2. **CI contract 0.2.0.** `metricSampleSchema`, `HEALTH_STATES` (added for the assistant in REQ-AI-001) and
   `LAYER_HEADLINE_METRIC[layer].metric`, the ClickHouse metric name whose latest sample is the headline;
   `HEADLINE_METRIC_NAMES` lists them without repeats. The unknown layer's headline (`lastSeenDays`) is derived by
   the API from `observedAt`, never sampled.
3. **Event contract 0.2.0.** `openmap.metric.sampled`: the reconciler resolves each sample's reference to a CI id
   (new CIs of the same result included), drops samples whose CI it cannot find (they are not parked; the next
   sweep samples again) and emits events of at most `RECONCILER.samplesPerEvent` samples with subject = run id. The
   outbox row is pending for ClickHouse only; no graph node, search document or live update carries a sample.
4. **ClickHouse.** The dispatcher inserts the samples into `metrics` (one row each, `source_run_id` = the run).
   Migration 0003 adds `metrics_latest` (ReplacingMergeTree keyed by tenant, CI, metric, versioned by ts) fed by a
   materialized view, so a page of CIs reads its headlines with one primary-key IN query and `argMax(value, ts)`.
5. **GraphQL 0.8.0.** `HeadlineMetric { key label unit metric value observedAt }` and `Ci.headlineMetric`
   (non-null; value null until sampled). A per-request batch loader asks ClickHouse once per page for the CIs'
   headline metrics; the query runs in an OpenTelemetry span and is counted by `openmap_clickhouse_queries_total`.
6. **Synthetic estate.** Every CI of a known layer carries one sample of its layer's headline metric per result,
   subnets add `ipam.subnet.utilisation_percent` and PDUs `dcim.power.watts`, from attributes the generator already
   set where they exist (PDU `measuredKw`) and otherwise from the slot's deterministic RNG. Replaying the estate
   fills `metrics` and the two existing views the way a real sweep would.
7. **Console.** `HeadlineMetric` renders the label through `metric.<key>` (en and ar), the value with the contract
   unit and an explicit "no sample yet" state; it sits on every CMDB row, the CI detail header, focus-search hits and
   the impact panel. `CI_SUMMARY_FIELDS` selects it, so every screen that shows a CI summary receives it.

## Consequences

Collectors can start reporting measurements without a contract change per metric. The reconciler's per-result
work grows by the sample pass (identity lookups already load the referenced CIs). The API gains its first ClickHouse
dependency at request time; a ClickHouse outage fails the `headlineMetric` field of a page, not the page, and is
visible in the new counter. IPAM utilisation and DCIM power keep their attribute-based computation for now; moving
them onto the views is a follow-up that needs no further contract change.
