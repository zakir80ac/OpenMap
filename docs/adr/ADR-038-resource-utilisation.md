# ADR-038 — Resource utilisation

Status: Accepted and implemented (REQ-CMDB-034, 2026-11-07) · Date: 2026-11-07 · Tracker: REQ-CMDB-034

## Context

Device42 shows CPU, memory, disk and power utilisation per device and uses it for rightsizing and capacity
(CAPABILITY-MAP §2). OpenMap already carries metric samples from collectors to ClickHouse (ADR-016) and reads one
headline metric per layer, but no collector sampled memory, disk or power, and nothing read utilisation as a whole.

## Decision

1. **One name per measure and CI type** (`packages/contracts/src/utilisation.ts`, CI 0.4.0, collector 0.4.0):
   `host.{cpu,memory,disk}.utilisation_percent` and `host.power.watts`, `vm.*` for guests, `container.*`, and
   `dcim.power.watts` for PDUs. Percentages are shares of capacity; disk is the fullest filesystem, labelled with its
   mount. Readers ask ClickHouse for exactly these names; a collector joins by sampling them.
2. **Collectors sample during the visit they already make.** SSH (Linux): CPU busy share between two `/proc/stat`
   reads `UTILISATION.cpuSampleSeconds` apart, memory from MemTotal and MemAvailable, fullest filesystem from `df`.
   WMI: `_Total` processor time, `Win32_OperatingSystem` memory, fullest fixed volume. Redfish: chassis power drawn.
   Samples ride on the collector result (`Observation.Samples`) like every other metric.
3. **Hot and idle are deployment thresholds** (`UTILISATION.hotPercent` 85, `idlePercent` 10): hot when CPU, memory or
   disk reaches the hot share (capacity at risk), idle when CPU and memory both sit at or below the idle share
   (rightsizing or reclaim candidate). `utilisationState` in the contract is the single rule.
4. **Reading it.** GraphQL 1.16.0: `utilisation(filter, sort, first, offset)` reads `metrics_latest` once per request
   (latest per CI and measure), joins the CIs, classifies, sorts by the chosen measure and pages, with hot and idle
   counts, average CPU and memory and total power; `Ci.utilisation(hours)` reads `metrics` bucketed into
   `UTILISATION.seriesPoints` points with the average and peak. ClickHouse query spans and counters come from the API's
   ClickHouse service (`clickhouse.utilisation_latest`, `clickhouse.utilisation_series`).
5. **Console**: a Utilisation screen under Insight and a Utilisation tab on CI types that report it.
6. **Dev data**: synth-estate `utilisation-history` writes sample-only collector results (per-CI base, daily swing,
   disk growth; a share hot and a share idle) that replay through the real pipeline.

## Consequences

- Rightsizing and capacity questions are answered from discovery alone, with no separate monitoring product.
- A one-second CPU read per Linux host adds a second to each SSH visit; the scheduler's concurrency absorbs it.
- Hypervisor-reported VM statistics (vCenter quick stats) can sample the same `vm.*` names later without changing
  readers.
