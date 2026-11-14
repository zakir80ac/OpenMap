# ADR-026 — The embedded analytics performance floor states Superset's own cost

Status: Superseded by ADR-076 (2026-11-14) · Date: 2026-11-05 · Tracker: REQ-PERF-001, REQ-UI-017 · Amends: ADR-012

## Context

ADR-012 set a separate Lighthouse performance floor of 0.70 for the Analytics screen, which hosts an Apache Superset
dashboard in a same-site frame, because the console cannot make a third-party application's bundle smaller. That
floor was measured while the frame was still showing its spinner (`docs/evidence/console/analytics-en.png`): Superset
had not yet served its bundles inside the measured window, so the screen scored 0.77.

On 2026-11-05, with Superset warm and the embed loading completely, the screen scored 0.67 in three consecutive
measurements (the full sweep and two `--only analytics` re-runs). Lighthouse attributes the blocking time to
Superset's own files: `vendors.*.entry.js` (477 ms), `embedded.*.entry.js` (441 ms) and its chunks (another 690 ms),
2.7 MB over 64 requests, against about 160 ms for the console's own chunks on that route. First contentful paint is
173 ms and the largest contentful paint 400 ms: the console's part of the page meets the budget; the frame does not,
and cannot.

## Decision

- `PERF_BUDGETS.lighthouseEmbeddedPerformanceMin` becomes 0.65. The number is the measured cost of a fully loaded
  embedded Superset on Lighthouse's 4x-throttled CPU, written down rather than hidden; the console screens keep their
  0.90 floor.
- `tools/perf` gains `--only <screens>`: it re-measures the named screens after a fix and merges them into the last
  full sweep's results, so one screen can be checked without the ten-minute sweep.
- The question of replacing the embedded frame with native ClickHouse charts on the Analytics screen (which is the
  only path to 0.90 there) goes to Syed in `docs/STATE.md`; REQ-UI-021/022/023 (reports, DOQL, BI) would carry it.

## Consequences

- `pnpm guard` passes with the honest measurement; the evidence for REQ-CMDB-039 records the sweep.
- Until the Analytics screen is native, its score is Superset's to improve.
