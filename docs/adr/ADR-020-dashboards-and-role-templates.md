# ADR-020 — Dashboards: a wizard, persona templates and a widget catalogue; Horizon refinements

Status: Accepted · Date: 2026-11-04 · Tracker: REQ-UI-030, REQ-UI-031, REQ-UI-032 · Contracts: dashboard 0.1.0 (new), GraphQL 0.10.0

## Context

The landing dashboard was one fixed screen (four KPIs, service health, layer summary). Syed asked for a wizard and
customisation first, then real use-case dashboards for an Administrator, a CTO/CIO, a CISO and Finance, with the
Mantine, Gentelella and Haze dashboards as cues (KPI tiles with sparklines and deltas, range segments, donuts,
category bars, activity feeds; a mix of dark and light, "don't use as is"). He also found the embedded Superset
white against the Horizon console and asked for more professional type and floating surfaces.

## Decision

### Contract and storage

- `packages/contracts/src/dashboard.ts` is the vocabulary: five personas, twenty-four widget kinds grouped by the
  screen whose data they show, four sizes on a four-column grid, the persona templates (ordered widget lists whose
  sizes complete rows), and the dashboard shape. The console renders a kind, the API validates it, and a template is
  the same list on both sides.
- A dashboard is a Postgres row (`dashboards`, migration 0014): tenant, owner (username), name, persona, shared,
  default flag, the widget list as JSON. The owner edits and deletes; a shared dashboard is readable by the tenant;
  the first dashboard a user creates is their default until they choose another.
- GraphQL 0.10.0 adds `Dashboard`, `DashboardInput`, the four mutations and `estateStats`: one aggregate the widgets
  read in a single round trip (register counts and purchase totals per stage straight from Postgres, licence and
  vulnerability facts from the software service, plans, rack power, subnet utilisation, Nodes, integrations, open
  incidents, and the daily trend series from ClickHouse over `DASHBOARD.trendDays`). Money totals are per currency,
  never mixed.

### Console

- First visit without a dashboard: the wizard (persona → widgets and sizes → name, sharing, summary → create).
  Afterwards: the dashboard in the URL, else the default; a switcher when there are several; New opens the wizard
  again; Customize edits in place (add from the catalogue, remove, resize, reorder) and saves through
  `updateDashboard`; share, make default and delete live in the same bar.
- Every widget is a component in `components/dashboard/widgets.tsx` that reads live queries (the aggregate or the
  screen's own query); none carries static data. Widgets link to the screen they summarise.
- Templates: Admin (discovery, Nodes, integrations, trend, platform settings, layers, jobs, audit feed); CTO/CIO
  (service health, incidents, estate size, end of support, SLA budgets, trend, layers, recent what-ifs, plan
  spend); CISO (vulnerabilities by severity, exposure, end of support, service health, SIEM/SOAR integrations,
  hardware leaving support, audit feed); Finance (asset value in service, annual licence cost, licence compliance,
  power draw, register by stage, plan spend by status, warranty horizon).

### Horizon refinements (REQ-UI-031, REQ-UI-032)

- Display face: Sora (geometric, professional at every size) replaces Chakra Petch; body Inter and mono JetBrains
  Mono stay. One token change, one font loader change.
- Floating surfaces are opt-in (`om-float`): a layered ambient and key shadow at rest, a lift and an accent halo on
  hover, an idle drift for tiles (`om-float-idle`). Opt-in because a transform makes a stacking context and a card
  that holds a dropdown must not float (ADR-018 lesson). Reduced motion removes the lift and the drift.
- New primitives in `packages/ui`: `Sparkline` (gradient area line with a glow and a last-point dot, mirrored in
  rtl), `Donut` (proportional ring with per-segment glow and a centre figure) and `Segmented` (exclusive options
  as a radiogroup). SVG only, every number a token or a named constant.
- Superset: the provisioner sets the dashboard's colour scheme to a registered Horizon palette and its CSS to the
  console's dark surfaces, text, grid and legend colours (`superset_config.py` registers the scheme; the dashboard
  `css` and `json_metadata.color_scheme` are rewritten on every provisioning, so an existing dashboard updates).

## Consequences

- The old fixed dashboard is gone; its tiles are widgets (`estate.cis`, `services.health`, `estate.layers`) in every
  template. The sign-in walkthrough still lands on an h1 "Dashboard" (the wizard carries it), so T-087 and the
  Lighthouse flow are unchanged.
- A new widget is a contract change (kind added to `WIDGET_KINDS`, strings in both locales, a component in the
  registry): minor bump of the dashboard contract.
- The estate aggregate costs one ClickHouse and several Postgres reads; it is cached per tenant for
  `DASHBOARD.refreshMs` by the console's query client, not by the API.
