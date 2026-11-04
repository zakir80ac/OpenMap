# Horizon visual language and the 3D digital twin (REQ-UI-028, REQ-UI-029, ADR-018)

Captured 2026-11-04 on the dev compose stack with the synthetic estate (4 rooms, 101 racks, 2,235 devices).

## What changed on screen

- **Display face.** Chakra Petch for headings, figures and the brand mark (upper-case, tracked); Manrope stays the
  fallback, Inter the body face, JetBrains Mono for codes, IBM Plex Sans Arabic in the ar locale.
- **Surfaces.** Every card and panel carries a holographic gradient border (cyan at the start, violet in the middle,
  fading out) painted under the surface, HUD corner brackets, an entrance rise, and figures glow in their accent.
  Live bars carry a travelling sheen, live dots an expanding ring. All of it comes from `packages/ui` tokens and the
  stylesheet rules the console injects, so the sixteen existing screens inherited it without per-screen edits.
- **Ground.** Navy-black with three aurora washes on the root and a perspective grid floor behind every element,
  drifting one cell per period on the compositor only. `prefers-reduced-motion` stops every animation.
- **Shell.** The sidebar's active item shows a lit indicator bar and a cyan-to-violet tint; section labels are mono
  caps with a rule; the top bar ends in a gradient hairline; section eyebrows start with a glowing lead line.
- **Digital twin (`/twin`).** The estate's rooms as glass slabs, racks as instanced boxes at true proportions
  (0.6 × 1.2 m, 44.45 mm per unit) coloured by power load, device plates stacked at their units in their layer colour;
  a focus CI's dependency graph lifted onto stacked planes in `CI_LAYERS` order, one node grid per plane, every edge
  in one line batch, service-path edges thick. Orbit, hover and click; a rack opens its devices and feeds, a node its
  CI, "Focus here" re-centres the planes on it. The scene is a client-only chunk loaded after the page paints and
  renders on demand.

## Measurements

Lighthouse (`pnpm --filter @openmap/perf lighthouse`, console image rebuilt with the Horizon stylesheet, cold
"sign-in" step first; floors perf 0.90 / a11y 0.95 / best-practices 0.95, analytics embedded floor 0.70):

| Screen | Performance | Accessibility | Best practices |
| --- | --- | --- | --- |
| sign-in | 0.99 | 1.00 | 1.00 |
| twin | 0.95 | 1.00 | 1.00 |
| dcim | 0.90 | 1.00 | 1.00 |
| analytics (embedded Superset) | 0.80 | 1.00 | 1.00 |
| discovery, ipam, settings | 0.99 | 1.00 | 1.00 |
| dashboard, setup, layers, dependencies, cmdb, assets, software, services, impact, integrations, vulnerabilities, assistant | 1.00 | 1.00 | 1.00 |

The first sweep scored the sign-in step 0.00 with Lighthouse's `NO_FCP` error: every card rose from opacity 0, so
Chrome never recorded a first contentful paint on a page that is all cards. A probe of the same URL with
`prefers-reduced-motion` scored 0.99, which pinned it on the animation; the rise now moves without fading and the
cold step scores 0.99.

Twin on the dev estate (replayed at scale 0.05): 4 rooms, 101 racks and 2,235 device plates in three instanced
meshes; a host's operating system as the focus CI puts 1,707 nodes on 8 layer planes with one `lineSegments` batch
for every edge and up to 300 thick service-path lines. The scene renders on demand (no frame without input), the
device pixel ratio is capped at 1.5, and the chunk loads after the page paints.

`pnpm -w guard` ok with these results; `pnpm i18n:check` en and ar in sync; console unit tests 195, ui 40;
`e2e/twin.spec.ts` 3 passed (setup, en, ar); walkthrough re-captured every screen in both locales.

## Tests

| Test | Covers |
| --- | --- |
| `packages/ui` tokens and components (40) | Horizon variables, keyframes and rules; the effects token group; dot ring and bar sheen markup |
| T-119 `apps/console/src/lib/twin-model.test.ts` | rooms tiled without overlap, racks by row and position at true proportions, device plates at their units, load colours, plane grid with the root first, plane growth, camera framing |
| T-120 `apps/console/src/components/twin/TwinView.test.tsx` | facility from the racks query, rack selection and device list, focus graph on the planes with the legend, node selection and "Focus here" (en, ar) |
| T-121 `apps/console/e2e/twin.spec.ts` | WebGL canvas with a positive rack count, a host focus laying its dependencies on the planes, screenshots (en, ar) |
| T-087 `apps/console/e2e/walkthrough.spec.ts` | every screen, the twin included, captured with the Horizon look in en and ar |

## Screenshots

`console/twin-{en,ar}.png`, `console/twin-focus-{en,ar}.png`, and the walkthrough set (`console/*-{en,ar}.png`)
re-captured with the Horizon look.

## Notes

- Dropdowns inside cards paint under the cards that follow when the entrance animation leaves a transform behind;
  the rise uses fill-mode `backwards` for that reason (found with the focus search on the twin).
- The impact query in both directions at depth six returns 1,707 nodes for a host's operating system on the synthetic
  estate; the per-plane grid keeps that readable and the edge batch keeps it at one draw call. The 2D lane positions
  were tried first and put a layer's nodes on one 3 km line.
- The perf tool now prints Lighthouse's runtime error and audit warnings for any screen under budget, so a zero score
  names its cause in the log instead of needing a probe.
