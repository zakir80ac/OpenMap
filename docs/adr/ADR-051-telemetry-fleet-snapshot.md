# ADR-051 — The health and telemetry fleet: one snapshot per tenant

Status: Accepted (REQ-UI-027, 2026-11-08) · Date: 2026-11-08 · Tracker: REQ-UI-027 · Contract: GraphQL 1.23.0

## Context

REQ-UI-027 asks for a fleet table with these columns:
- CI, category and site, IP/FQDN and health;
- CPU, memory, IOPS, throughput and Apdex.

It must be backed by ClickHouse metrics, filtered by health and category, virtualised, and within its p95 budget on
100k CIs. That budget is `PERF_BUDGETS.screenInteractionP95Ms`, 100 ms.

The columns live in three stores:
- **ClickHouse `metrics_latest`:** the measurements.
- **Postgres:** the CI's name, category, site and address.
- **Memgraph:** health, as the BSM engine propagates it.

Joining them per request costs seconds at this size. On the scale-1 estate, 504,474 CIs have a fleet measurement;
building the join takes 3.4–4.4 s. REQ-CMDB-034's utilisation register joins its stores per request, which is fine for
its smaller scope, but not here.

## Decision

1. **Fleet contract (`packages/contracts/src/telemetry.ts`).**
   - **Measures** (`FLEET_MEASURES`) and the metrics behind each (`FLEET_METRICS`):
     - CPU and memory are the utilisation metrics;
     - IOPS are storage arrays' and database instances';
     - throughput is the network layer's headline metric, in Gb/s;
     - Apdex is the application layer's.
   - **Address and site:** from the CI's `site`, `fqdn`, `ipAddress` and `managementIp`.
   - **Rows:** every CI with at least one of these samples.
2. **One snapshot per tenant in the API (`TelemetryService`).**
   - **Build:** the ClickHouse latest values, then the matching CIs from Postgres (one `= ANY(uuid[])` parameter) and
     health from Memgraph, side by side.
   - **Sorting at build time:** rows are ranked by name with a collator, and every sort key's order is computed from
     that rank as a numeric tie-break.
   - **Text search:** every row's search text (name, address, site) is joined into one string in rank order, with line
     offsets. A text filter is one native `indexOf` scan that marks matching ranks; the per-row substring test cost
     about 100 ms at 500k rows.
   - **Requests** walk one pre-sorted array and slice a page. Health counts are taken before the health filter applies,
     so the pills show what choosing each would give.
   - **Refresh:** a snapshot older than `TELEMETRY.snapshotMs` (30 s) is rebuilt in the background while the old one
     keeps answering. Only a tenant's first request waits for a build. At most `TELEMETRY.snapshotTenants` (8)
     snapshots are kept, least recently used first out.
   - **Telemetry:** a `telemetry.snapshot` span, and `openmap_telemetry_snapshot_seconds` by outcome.
3. **GraphQL 1.23.0.** `telemetryFleet(filter: FleetFilter, sort: FleetSort = health, first, offset): FleetPage!`.
   - `FleetRow` carries the CI, site, address, health and the five measures.
   - `FleetPage` carries the total, the four health counts and `asOf`, the snapshot's build time.
4. **Pages and counts.**
   - Health counts per category are kept with the snapshot. A page takes its counts and total from them (or from the
     text matches) and walks the order only until the page is full.
   - Each sort key's order is also kept per category, so a one-category page reads only its category.
5. **Console `/telemetry`.**
   - Health pills with counts (multi-select), category pills and a text filter.
   - Sortable column headers, with `aria-sort`.
   - A TanStack Virtual table over offset pages of `TELEMETRY.defaultPageSize` (50), refreshed every `snapshotMs`.
   - The row's own health field is read, never the CI's: that would be a graph read per row.

## Results (`docs/evidence/telemetry-fleet.json`)

**In-process** (T-495, scale-1 tenant `570b1953`, 504,474 rows, 70 pages: 7 sort keys × 5 filters × 2 offsets):

| | Before | After |
| --- | ---: | ---: |
| Snapshot build (background) | — | 3.4–4.5 s |
| Warm page p95 | 496 ms (sorting per request) | **29 ms** (p50 5.6 ms) |

**Over HTTP** (`tools/perf telemetry-budget`: k6 with 8 users and no think time, random sort, filter and offset):

| Estate | Fleet rows | p95 | Median | Budget (100 ms) |
| --- | ---: | ---: | ---: | --- |
| Seed 44, scale 0.25 (138k CIs, the 100k class) | 126,627 | **62 ms** | 37 ms | met |
| Scale 1 (551k CIs) | 504,474 | 130 ms | 77 ms | missed |

The same changes, measured at 504k rows over HTTP, in order:

| Version | p95 |
| --- | ---: |
| First version | 366 ms |
| Totals and health counts from the snapshot, page scan stops when full, no per-row CI health read | 193 ms |
| Pages of 50 rows, per-category orderings | 130 ms |

With 8 users and no think time, the API's single Node process queues them, so per-request CPU sets the p95. That is about
10 ms at 500k rows: the page's GraphQL resolution, plus a health filter that walks the order until it has the page.
Partitioning by health as well, and resolving the page's CIs from the snapshot, are the next steps for the scale-1 size.

## Consequences

- **Freshness:** a figure can be up to `snapshotMs` older than ClickHouse, plus one build time. Collectors sample in
  minutes, so the snapshot is not what limits freshness. `asOf` says when the snapshot was taken.
- **Memory:** one 500k-row snapshot holds the rows, seven orderings of them, and a search string of about 30 MB.
  Eight tenants of that size fit in the API's heap, and smaller tenants cost proportionally less.
- **Paging:** pages are offset-based over a snapshot. A refresh can move a row between pages while someone scrolls;
  the table refetches every page on refresh, so it shows one consistent snapshot.
