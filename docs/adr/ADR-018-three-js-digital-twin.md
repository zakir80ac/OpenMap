# ADR-018 — three.js, react-three-fiber and drei for the 3D digital twin; the Horizon visual language

Status: Accepted · Date: 2026-11-04 · Tracker: REQ-UI-028, REQ-UI-029

## Context

Syed's customer judged the console "generic, AI-generated" and asked for a futuristic look and a real 3D digital
twin rather than the isometric SVG rack and the 2D dependency map. CLAUDE.md §0 positions OpenMap against polished
commercial tools, and the memory of the approved direction (Obsidian Pro: deep ground, glass, cyan and violet, 3D
depth) already pointed this way. Two decisions follow: how to draw real 3D at 60 fps on a 100k-CI estate, and how to
give the whole console a distinctive surface language without touching every screen by hand.

## Decision

### Renderer

- `three` 0.187.0 (MIT) is the WebGL engine; `@react-three/fiber` 9.8.2 (MIT) binds it to React 19; `@react-three/drei`
  10.7.9 (MIT) supplies `Instances`, `OrbitControls`, `Grid`, `Edges`, `Line` and `Html`. All three are browser
  libraries with no network access, so the air-gap profile is unaffected; they are bundled, never fetched.
- The scene (`apps/console/src/components/twin/TwinScene.tsx`) is a client-only chunk loaded after the page paints
  (`next/dynamic`, `ssr: false`), so the twin route's first paint is the shell and KPIs and the Lighthouse budget holds.
- Geometry is a pure model (`apps/console/src/lib/twin-model.ts`, unit tested): the `racks` query becomes rooms tiled
  in a grid, racks placed by their `row` and `position` attributes at true proportions (0.6 m × 1.2 m, 44.45 mm per
  unit) and device plates stacked at their units in their layer colour; the impact graph of the focus CI, laid out by
  the same lane or force layout as the 2D map (in the worker above `TWIN.workerMinNodes`), is lifted onto stacked
  planes in `CI_LAYERS` order. Racks, devices and nodes are instanced meshes (one draw call per kind), edges are
  `Line2` segments, and rendering is on demand, so an idle twin costs no frames.
- Every dimension, threshold, camera and lighting number lives in `TWIN` in `@openmap/constants` with a rationale;
  `apps/console` carries no numeric literal (guard).
- Sigma.js (ADR-007) remains the 2D dependency map; the twin is a second view over the same impact result, not a
  replacement.

### Horizon visual language (REQ-UI-028)

- One token module, `packages/ui/src/tokens/effects.ts`: the holographic border gradient, HUD corner brackets, the
  perspective grid ground, aurora washes, value glow, bar sheen, entrance rise and the live ring. The stylesheet the
  console injects gains unlayered surface rules (`componentRulesCss`) for `.om-card`, `.om-glass-panel`, the KPI
  value, the bar sheen and the dot ring, plus four keyframes; `prefers-reduced-motion` turns every animation off.
- The display face becomes Chakra Petch (squared, HUD-like) for headings, figures and the brand, with Manrope as
  fallback; body stays Inter, code JetBrains Mono, Arabic IBM Plex Sans Arabic. Fonts load through `next/font` as before.
- The ground is painted on the root (navy-black with three aurora washes) so the tilted, slowly drifting grid floor
  behind every element stays visible; the sidebar shows a lit indicator bar and ruled section labels, the top bar a
  gradient hairline, section eyebrows a glowing lead line in mono caps.
- Because the look lives in tokens, rules and the four shared components, every existing screen inherited it without
  per-screen edits; Lighthouse accessibility stays at 1.0 (contrast tokens unchanged).

## Consequences

The console bundle grows by the three.js chunk on the twin route only. WebGL is required for that route; the rest of
the console needs none. The DCIM screen keeps its isometric SVG elevation for now and links into the twin; replacing
it with the shared rack mesh is a follow-up. Rooms are placed by the generator's `row`/`position` attributes; a
collector that reports neither gets racks in discovery order, which the model documents as the fallback.
