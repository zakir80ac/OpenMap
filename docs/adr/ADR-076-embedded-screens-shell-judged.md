# ADR-076 — An embedded screen's shell is held to the console floor; the embedded application's pass is reported

Status: Accepted · Date: 2026-11-14 · Tracker: REQ-PERF-001, REQ-UI-017, REQ-QA-004 · Supersedes: ADR-026 (its floor)

## Context

ADR-026 gave the Analytics screen, which hosts the tenant's Apache Superset dashboard in a same-site frame, a
Lighthouse performance floor of 0.65. That number stated the cost of Superset's own bundle (2.7 MB, about 1.5 s of
script on Lighthouse's throttled CPU) executing in the console's renderer, measured on the dev host.

The CI runner (since REQ-QA-004 went green, the e2e job runs Lighthouse on a two-core shared runner, median of three
passes) measures the same screen at 0.64 to 0.67: the floor sat inside the runner's spread, so the build went red or
green on Superset's boot time. On 2026-11-14 the tenant dashboard's data was checked and is not the cost: its five
ECharts charts draw 400 and 961 rows at most. The blocking time is Superset's vendors, embedded entry and chart
plugin bundles, which OpenMap does not build.

A floor that judges a third-party application's boot time does two things badly: it holds OpenMap to a number it
cannot move, and at 0.65 it stopped holding OpenMap's own shell around the frame to anything.

## Decision

- An embedded screen (`PERF_BUDGETS.lighthouseEmbeddedScreens`, today `analytics`) is audited twice in every sweep:
  - **`analytics`**: the embedded application's origin (`PUBLIC_SUPERSET_URL`) blocked, held to the console floors
    (performance 0.90, accessibility 0.95, best practices 0.95). This is OpenMap's own page and is judged like every
    other screen.
  - **`analytics+embedded`** (`PERF_BUDGETS.lighthouseEmbeddedSuffix`): the application loaded. Its performance is
    reported on every run (the runner prints it as `note`, and `lighthouse.json` keeps it), and it is judged on
    accessibility and best practices only.
- `lighthouseEmbeddedPerformanceMin` is removed. `lighthousePerformanceMin(label)` in `packages/contracts`
  (`perf-results.ts`), which `pnpm guard`, the Platform health screen and the Lighthouse runner all use, returns
  `null` for an embedded application's pass.
- The question ADR-026 sent to Syed is unchanged: replacing the frame with native ClickHouse charts is the only way to
  hold the loaded screen itself to 0.90.

## Consequences

- OpenMap's shell around the frame is held to 0.90 instead of 0.65: on 2026-11-14 it scored 1.0 on the dev host.
- Superset's cost stays visible: `analytics+embedded` scored 0.75 on the dev host the same day.
- A slower or faster Superset no longer turns the build red or green.
- The perf result file's shape is unchanged. Its judgement changed: `docs/CONTRACTS.md` records it.
