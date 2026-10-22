# ADR-007 — Sigma.js and graphology for the dependency map renderer

Status: Accepted · Date: 2026-10-22 · Tracker: REQ-UI-007, REQ-DEP-003, REQ-DEP-005

## Context

The dependency map must render the impact neighbourhood of any CI at 60 fps and stay responsive on a 100k-node
estate (CLAUDE.md §0, `PERF_BUDGETS.graphRenderFps`, `PERF_BUDGETS.impactQueryGraphNodes`). CLAUDE.md §9 already
names the approach: "graph through Sigma.js in a Web Worker". SVG and Canvas 2D renderers fall below 60 fps in the
low thousands of edges; only WebGL keeps the frame budget at the sizes the impact query can return.

## Decision

- `sigma` 4.0.3 (MIT) renders nodes and edges in WebGL 2 in `apps/console/src/components/dependencies/DependencyCanvas.tsx`.
- `graphology` 0.26.0 (MIT) is the in-memory graph model Sigma renders from; `graphology-types` 0.24.8 (MIT) supplies
  its typings; `graphology-layout` 0.6.1 (MIT) is available for the force layout mode (REQ-UI-007 "force layout"
  toggle, next increment). All four are pure browser libraries with no network access, so the air-gap profile is
  unaffected.
- Layout runs off the main thread. The lane layout (`apps/console/src/lib/graph-layout.ts`, pure, unit-tested) is
  executed in `lane-layout.worker.ts` through `new Worker(new URL(..., import.meta.url))`; graphs smaller than
  `DEPENDENCY_MAP.workerMinNodes` are placed synchronously because a worker round trip would cost more than the
  layout. The hook `useLaneLayout` discards answers for superseded requests.
- Every geometry and interaction number (lane height, node spacing, node sizes, edge widths, label sizes, camera
  ratios, zoom duration, tooltip offset) lives in `DEPENDENCY_MAP` in `@openmap/constants` with a rationale, so
  `apps/console` carries no numeric literal (guard rule).
- Node colour is the layer accent (`layerColor`), node size shrinks with distance from the focus, edges are coloured
  by the predicted state of the dependant end (the impact contract carries predicted state per node, not a
  relationship type) and, for the edges of the focus CI whose relationships are loaded, by relationship family.
  Hidden layers are bridged out of the paths rather than cutting them.

## Alternatives considered

- D3 force + SVG: simplest, but SVG DOM nodes make 60 fps unreachable past a few thousand elements.
- Cytoscape.js: Canvas 2D, broad feature set, but no WebGL path and a 1.3 MB bundle; layouts run on the main thread.
- react-force-graph / three.js: WebGL, but a 3D-first API for a 2D lane layout and a heavier dependency surface.
- Custom WebGL: full control, but reimplements picking, labels and camera that Sigma already provides and tests.

## Consequences

- Four new runtime dependencies in `apps/console`, all MIT, not in SPEC.md's component table — hence this ADR. The
  tracker CLI has no `components` sub-command, so the Components sheet row is: Sigma.js 4.0.3 · UI · MIT · library ·
  air-gap ready Y · replaced-by Cytoscape.js (Canvas 2D fallback); graphology 0.26.0 · UI · MIT · library · Y.
- WebGL 2 is required; when a browser cannot create a context the canvas shows a textual notice and the impact panel
  beside it still lists every affected service, so no information is lost.
- The render-fps budget is measured by `tools/perf` (graph-render result consumed by `pnpm guard`); the lane layout's
  own time is shown on the map HUD alongside the impact query's `durationMs`.
