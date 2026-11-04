# The Layers screen as an equipment scene, and the formal profile (REQ-UI-033, REQ-UI-034, REQ-UI-035, ADR-021, ADR-022)

Captured 2026-11-05 on the dev compose stack with the synthetic estate.

## What changed on screen

- **Layers.** The isometric SVG is replaced by a three.js scene under a three-quarter orthographic camera: twelve
  slate planes stacked in contract order, the data centre at the bottom, each with an accent strip in its layer colour
  and an HTML label beside it. Clicking a plane, or its row, zooms onto that layer: the others recede and the
  layer's equipment stands on the plane, built from primitives at plausible proportions: 42U cabinets with rails and doors; a 32-port
  switch beside a firewall appliance; 2U servers with drive bays; a 12-slot disk shelf with a SAN switch; a host with
  translucent VM cards; availability-zone slabs; a server with a console screen; a host carrying container blocks;
  stacked database drums; a three-server application tier; platform cards for SaaS; a translucent crate for unknown.
  A layer repeats its unit by its share of the largest count. A focus panel shows the count, the health split, the
  platform marks and a link into the CMDB filtered to the layer; Escape or Back returns. Vendor marks sit beside
  the layer's row in the visibility list as crisp SVG (VMware, Nutanix, Red Hat, Ubuntu, Kubernetes, Docker, Cisco, Fortinet, Palo Alto, Dell, HP,
  NetApp, PostgreSQL, MongoDB, Google Cloud as icons; Microsoft 365, Windows Server, Hyper-V, Azure, AWS, Oracle,
  Salesforce, ServiceNow as names). No text inside the canvas: the visibility list is the legend, hover syncs both
  ways, a click on a tier toggles the layer, and an accessible tier list mirrors the scene.
- **Formal profile, every screen.** Holographic borders, HUD brackets, the grid floor, aurora washes, bar sheens, dot
  rings, value glows and entrance rises are removed from `packages/ui` (tokens, variables, keyframes and rules), not
  switched off. Cards are plain bordered glass surfaces; the dashboard tiles keep the layered float shadow and a 2 px
  hover lift; pills and bars glow only on request; the sidebar's active item is a quiet tint with an indicator bar.
- **Why the first cut was dropped.** The holographic stack (wafers, abstract spinning glyphs, projected labels) was
  rejected by Syed as game-inspired with unreadable text; its ADR was rewritten rather than kept.

## Measurements

Lighthouse (`pnpm --filter @openmap/perf lighthouse`, final sweep with the dev machine quiet; floors perf 0.90 /
a11y 0.95 / best-practices 0.95, analytics embedded floor 0.70):

| Screen | Performance | Accessibility | Best practices |
| --- | --- | --- | --- |
| layers (the new scene) | 1.00 | 1.00 | 1.00 |
| twin | 1.00 | 1.00 | 1.00 |
| sign-in, dashboard, cmdb, settings | 0.99 | 1.00 | 1.00 |
| dcim | 0.97 | 1.00 | 1.00 |
| discovery | 0.95 | 1.00 | 1.00 |
| analytics (embedded Superset) | 0.77 | 1.00 | 1.00 |
| setup, dependencies, assets, software, services, impact, integrations, ipam, vulnerabilities, assistant | 1.00 | 1.00 | 1.00 |

Two scene revisions on the way there, both measured: the first stack with projected two-line labels overlapped at
the step size (Syed: "the text is all screwed up"); a twelve-tile grid lost the layering sequence and left the
equipment at ~100 px; the tile grid with a continuous frame loop scored 0.86 (total blocking time 334 ms) until the
loop went on demand and materials were shared per plane (0.98), the same change that lifted the twin to 0.99–1.00.

Unit: console 207 (T-125 included), ui 44, api 28; `pnpm -w guard` ok; e2e 15 passed on the final build
(T-126 layers in en and ar with the focus flow, T-087 walkthrough, shell, T-124 dashboard, T-121 twin, T-122 impact).

## Tests

| Test | Covers |
| --- | --- |
| T-125 `apps/console/src/lib/layer-stack-model.test.ts` | tier order and stepping, one equipment family per layer, units by share, vendor marks (icon only where the catalogue carries it), counts, health, visibility, camera |
| T-126 `apps/console/e2e/layers.spec.ts` | the canvas renders with a tier per layer in the accessible list; hiding a layer from the list hides its tier and showing it restores it (en, ar) |
| `packages/ui` tokens and components (44) | formal profile: no holographic variables or bracket rules, float shadow and lift, pulse only, reduced motion; pills and bars without a default glow |
| T-087 `apps/console/e2e/walkthrough.spec.ts` | every screen re-captured with the formal profile in en and ar |

## Screenshots

`console/layers-stack-{en,ar}.png`, and the walkthrough set (`console/*-{en,ar}.png`) re-captured.
