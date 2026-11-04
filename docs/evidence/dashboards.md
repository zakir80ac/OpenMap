# Dashboard wizard, role templates and Horizon refinements (REQ-UI-030, REQ-UI-031, REQ-UI-032, ADR-020)

Captured 2026-11-04 on the dev compose stack with the synthetic estate (replayed at scale 0.05).

## What changed on screen

- **First visit without a dashboard:** the wizard. Step 1 picks who it is for (Administrator, CTO / CIO, CISO,
  Finance, or start from scratch), each card naming what it shows and how many widgets it carries. Step 2 lists the
  catalogue by area with the template's widgets pre-ticked and a width segment per widget. Step 3 names it, offers
  sharing with the tenant, and summarises. Create writes the dashboard and opens it.
- **A dashboard:** its widgets on a four-column grid, every one painted from live queries (the estate aggregate or the
  screen's own query) and linking to the screen it summarises. A switcher when the user can see several; New runs the
  wizard again; Customize edits in place: add from the catalogue, remove, resize, reorder, save; share, make default
  and delete sit in the same bar. Only the owner sees Customize.
- **Templates.** Admin: discovery sweep, Nodes, integrations, estate trend, tenant settings, layers, collector jobs,
  activity feed. CTO/CIO: service health donut, open incidents, estate size, end of support, SLA budgets, trend,
  layers, recent what-ifs, plan budgets. CISO: vulnerabilities by exploitation and severity, internet exposure, end of
  support, service health, integrations, warranties ending, activity feed. Finance: asset value in service, annual
  licence cost, licence compliance, power draw, register by stage, plan budgets, warranties ending.
- **Horizon refinements.** Sora as the display face; floating cards (layered shadow, hover lift with a cyan halo,
  idle drift on tiles); sparklines with gradient fills and glowing strokes; donut rings; range segments.
- **Superset.** The embedded estate dashboard is provisioned with the Horizon colour scheme and a dark dashboard CSS,
  so the Analytics screen no longer paints white inside a dark console.

## Measurements

Lighthouse (`pnpm --filter @openmap/perf lighthouse`, final sweep with the dev machine quiet; floors perf 0.90 /
a11y 0.95 / best-practices 0.95, analytics embedded floor 0.70):

| Screen | Performance | Accessibility | Best practices |
| --- | --- | --- | --- |
| dashboard | 1.00 | 1.00 | 1.00 |
| sign-in, discovery, settings | 0.99 | 1.00 | 1.00 |
| dcim | 0.97 | 1.00 | 1.00 |
| twin | 0.95 | 1.00 | 1.00 |
| analytics (embedded Superset) | 0.77 | 1.00 | 1.00 |
| setup, layers, dependencies, cmdb, assets, software, services, impact, integrations, ipam, vulnerabilities, assistant | 1.00 | 1.00 | 1.00 |

GraphQL, measured through the console's own bearer token on the dev estate (101 racks, 2,437 mounted devices):

| Operation | Before | After |
| --- | --- | --- |
| racks, the twin's full selection | 1,737 ms | 508–583 ms |
| racks without the per-CI health field | 404 ms | 340–361 ms |
| incidents(open: true) | GraphQL error | 14 ms |
| estateStats (the dashboard aggregate) | — | one round trip, refreshed every 30 s |

Discovery screen layout shift (Lighthouse CLS): 0.267 → 0.020. Unit: ui 44, console 203, api 28, bsm-engine 27,
reconciler 15, contracts 13, db 82; `pnpm -w guard` ok; e2e T-124 (en, ar), T-121, T-122 and the walkthrough passed
on the final build.

## Tests

| Test | Covers |
| --- | --- |
| `packages/ui` components (44) | Sparkline points and rtl mirroring, donut shares and segment naming, segmented radiogroup |
| T-123 `apps/console/src/components/dashboard/DashboardView.test.tsx` | wizard from no dashboards → CISO template → create (persona, name, widget count); a dashboard's widgets from live queries; customise and save (en, ar) |
| T-124 `apps/console/e2e/dashboard.spec.ts` | the wizard on the real stack creates a Finance dashboard, its widgets paint live figures, customise and save round-trip (en, ar) |
| T-087 `apps/console/e2e/walkthrough.spec.ts` | every screen with the refined look |

## Screenshots

`console/dashboard-wizard-{en,ar}.png`, `console/dashboard-finance-{en,ar}.png`, `console/analytics-{en,ar}.png`.

## Notes

- T-124 first failed in customize mode: Playwright reported the remove button "intercepted" by the next card. The
  cause was real: a one-column widget's edit controls (width segment, move, remove) overflowed the card and sat over
  the neighbouring header. The widget header now wraps. Cards also stop floating while customizing, so the controls
  stay where the pointer is.
- The estate aggregate's first ClickHouse query aliased `toString(day) AS day`; ClickHouse resolves an alias before a
  column of the same name in `WHERE`, so `day >= {from:Date}` compared a String with a Date. Day aliases are `d`.
- The register holds only the fourteen plan-created assets on the dev estate, which the Finance template shows as
  "No cost recorded" for asset value: the honest figure, and the reason the full register across every layer is the
  next piece of work.
- The Analytics walkthrough screenshot catches Superset's own loading page (white, inside the iframe) before the
  dashboard CSS applies; the dashboard itself paints on the Horizon surfaces once loaded (verified in the browser:
  dark grid, glass chart cards, Horizon series colours). Superset 4.1 exposes no setting for its loading page's
  background, so that first moment stays Superset's.
- Two Lighthouse sweeps scored the twin 0.75–0.79 with no change to its code. The racks query behind its canvas took
  1.7 s, of which 1.3 s was the per-CI `health` field. The batch loader did batch the 2,437 ids into one Memgraph
  query, but that query, `MATCH (c:Ci {tenantId}) WHERE c.id IN $ids`, is evaluated per node when the list is a Bolt
  parameter: 1.0 s on the 28k-CI tenant, against 80 ms for `UNWIND $ids AS id MATCH (c:Ci {id: id, tenantId})`,
  which hits the unique id index. The three copies of that query (CI loader, BSM facts, BSM engine) now use the
  indexed form; the loader also flushes on the next macrotask so nested lists never split a batch. A stray kind
  cluster on the dev machine (a full core) depressed the scores further; it was stopped for the final sweep.
- The `incidents` query failed with "Cannot return null for non-nullable field Incident.service": three incidents
  from before a replay reset named business-service CIs the reset had recreated under new ids. The list now leaves
  such orphans out (and logs them), and a replay reset purges incidents, links and impact rows with the estate.
