# OpenMap — build state

Read this first in every session (CLAUDE.md §2). If this file and the tracker disagree, the tracker wins.

## Last session · 2026-11-05 (checkpoint 15: the Layers equipment scene and the formal profile)

Syed rejected the first Layers revision (holographic wafers and abstract glyphs, projected labels) as "horrible",
"game inspired" and unreadable, and asked for realistic objects (switches, firewalls, racks, servers, storage) with
vendor marks (VMware, Microsoft, Red Hat) and a final sweep to make the console formal. Done as ADR-021 (rewritten)
and ADR-022: the Layers screen is a three.js stack of twelve planes in contract order (Syed: "the initial layers
were better"); clicking a plane or its row zooms onto that layer, recedes the others and stands its schematic
equipment on the plane, with a focus panel (count, health, platforms, CMDB link) and Escape or Back to return;
equipment built from primitives (cabinets, a switch and firewall, 2U servers, a disk shelf and SAN switch, a hypervisor host with VM
cards, zone slabs, a console screen, a container host, database drums, an application tier, SaaS cards, a crate),
vendor marks beside each row of the list from `simple-icons` (CC0; names in chips where a logo is not licensable),
no text in the canvas, hover synced with the visibility list, an accessible tier list for the e2e (T-125, T-126). The formal
profile removed the holographic borders, HUD brackets, grid floor, aurora, sheens, rings, value glows and entrance
rises from `packages/ui`; cards are plain bordered surfaces with an opt-in float shadow; pills and bars glow only
on request; the sidebar active item is a quiet tint. Memory `ui-direction-obsidian-pro` carries the rules.

## Previous session · 2026-11-04 (checkpoint 14: dashboard wizard, role templates, Horizon refinements)

Syed's next asks after the what-if fix: a dashboard wizard and customisation with real templates for Admin, CTO/CIO,
CISO and Finance; more professional type and floating effects; a Superset that matches the theme. ADR-020.
Contract `dashboard` 0.1.0 (five personas, twenty-four widget kinds, four sizes, templates), GraphQL 0.10.0
(`dashboards`, `estateStats`, create / update / delete / set default), migration 0014 `dashboards`. The API's
`EstateStatsService` composes the register, licence, vulnerability, plan, power, IPAM, Node, integration and incident
facts plus ClickHouse daily trends in one query. The console's `/dashboard` opens the wizard on a first visit
(persona → widgets and sizes → name and sharing → create), then renders the dashboard's widgets on a four-column
grid from live queries, with a switcher, Customize (add, remove, resize, reorder, save), share, default and delete.
`packages/ui` gained `Sparkline`, `Donut` and `Segmented`, the floating-surface tokens and rules (`om-float`,
`om-float-idle`, opt-in because a transform makes a stacking context), and Sora replaces Chakra Petch as the display
face. Superset is provisioned with the Horizon colour scheme and a dark dashboard CSS (ANALYTICS.theme). Tests:
T-123 view (en, ar), T-124 e2e (en, ar), ui 44. Three defects found on the way and fixed: the per-CI `health`
lookup, `WHERE c.id IN $ids` with a Bolt parameter list, is a per-node scan in Memgraph (1.0 s for 2,400 ids) where
`UNWIND $ids AS id MATCH (c:Ci {id: id})` hits the unique index (80 ms): the racks query went from 1.7 s to under
0.5 s, and the same query in the BSM facts service and the BSM engine is fixed alike; the `incidents` query failed on three incidents that named CIs a replay reset had
recreated (orphans are left out and logged; a reset now purges incidents, links and impact rows); the discovery
sweep card changed height when its query resolved (Lighthouse CLS 0.27 → 0.02). A stray kind cluster on the dev
machine (`openmap-control-plane`, not ours to remove) eats a core; stop it before a Lighthouse sweep. Queue after this (memory `openmap-requests-2026-11-04`): the
Layers screen as an isometric stack with 3D holographic icons (REQ-UI-033), the full asset register across every
layer (REQ-CMDB-017/018 and a new register row), the finance module (costing, ROI, budgeting; new BSM rows).

## Earlier session · 2026-11-04 (checkpoint 13: what-if scenarios failed on every run)

Syed reported "Something went wrong" on every what-if run in Business services. Root cause, found by replaying the
run in the browser pane: the console sends the picked condition (`failed`, `power_loss`, …) as the scenario `kind`,
and the impact contract's `SCENARIO_KINDS` still listed the pre-console scope kinds (`component`, `power`, `rack`,
…), so `saveScenario` rejected every input with `invalid ScenarioInput` and the screen showed only the generic error.
Fixed by ADR-019: the scenario kinds are the conditions plus `maintenance`, `SCENARIO_KIND_SEVERITY` gives each its
starting state, the console's condition table and the API's `severityFor` both read the contract (impact 1.0.0;
Postgres enum recreated by migration 0012, GraphQL unchanged). Validation errors now carry their zod issues in the
message, and the impact screen prints the server's reason under the error card. Two more defects sat behind it:
the scenario `runbook` the contract declares had no column, so every scenario read failed its parse (migration
0013), and the impact traversal never followed `contains`, so a component's failure never reached its application
or any business service (`contains` is traversed from logical containers only, `GRAPH.impactContainerTypes`; the
Memgraph integration test covers a component reaching its service and a port not taking down its switch). T-122
runs a model on cbs-db on the real stack in both locales and expects affected services. Lesson: a screen whose
unit test stubs the API needs one e2e that exercises its mutation for real, and a "0 affected" result is a finding,
not a pass.

## Earlier session · 2026-11-04 (checkpoint 12: Horizon look and the 3D digital twin)

Syed's customer called the console "generic, AI-generated"; he asked for a futuristic look and a real 3D digital twin
(MFA and the corporate IdP parked). REQ-UI-028 and REQ-UI-029 done (ADR-018, `docs/evidence/horizon-twin.md`).
Horizon lives in `packages/ui`: an `effects` token group (holographic border, HUD brackets, grid, aurora, glow, sheen,
rise, ring), `componentRulesCss` rules for cards, panels, KPI values, bars and dots, four new keyframes, Chakra Petch
as the display face; the console paints the ground on `html` with a perspective grid floor on `body::before`
(transform-only drift), a lit sidebar indicator, ruled section labels, a top-bar hairline and mono eyebrows with a
glowing lead line. Every existing screen inherited it. The twin at `/twin` (three.js, react-three-fiber, drei): the
`racks` query becomes rooms, racks and device plates at true proportions (pure `twin-model.ts`, T-119), a focus CI's
impact graph is lifted onto stacked layer planes with a node grid per plane and one line batch for the edges
(1,707 nodes for a host's OS on the dev estate), instanced meshes, on-demand rendering, orbit, hover, click to a rack's
devices or a node's CI, "Focus here". T-120 unit (en, ar), T-121 e2e (en, ar), walkthrough captures `/twin`.
Three lessons: a card entrance that fades from opacity 0 leaves Chrome without a first contentful paint on a page
whose content is all cards (the sign-in gate scored NO_FCP), so the rise moves without fading; a lingering transform
after the entrance makes a card a stacking context and hides dropdowns under later cards (fill-mode backwards);
animating background-position on the full-screen grid repaints every frame, so the drift is a transform.
Lighthouse: twin 0.96, every screen at or above its floor; CMDB-038 summary selection kept lean (checkpoint 10).
Follow-ups: the DCIM elevation still draws its isometric SVG and links to the twin; per-site platforms in the twin
need the site of a room, which the racks query does not carry yet.

## Earlier session · 2026-11-04 (checkpoint 11: initial setup wizard)

Syed asked whether a fresh deployment has an onboarding wizard; it had none (CLI node registration, no way to create a
subnet or a credential from the console), and he called that vaporware. REQ-UI-020 and REQ-UI-024 are now done end to
end (ADR-017, `docs/evidence/setup.md`): GraphQL 0.9.0 adds `onboarding` and ten administrator mutations; `/setup`
walks six steps, each a real write. Organization and business units (tenants with derived slugs); sites (row plus the
site CI through the outbox, facility columns in migration 0011, code immutable as the CI identity, removal retires
the CI); inter-site links (`site_link` CI `connected_to` both ends); Discovery Nodes (one-time token minted like the
CLI, enrol command printed from `DISCOVERY_NODE_ENV`); credential sets (validated against the new
`CREDENTIAL_FIELDS` in the collector contract, written to OpenBao KV v2, reference kept, values redacted in the
audit log; the API creates the `openmap` mount on first use because `openbao server -dev` only mounts `secret/`);
discovery scopes (subnet CI `located_in` the site with the credential as scope attributes, same CIDR updates);
integrations (existing editor embedded); generate (CIs completed, `generatedAt`, first sweep). The CI repository gained
`create`/`retire`/`findCurrentByIdentity` with the reconciler's identity key. Tests: T-118 (API integration, 20
passed), T-116 (SetupView unit, en+ar), T-117 (e2e setup, 3 passed on the rebuilt images), walkthrough captures
`/setup`. The dashboard shows a setup call to action until the twin is generated.
Observations: a sweep with no assignable targets stays "running" in the sweep view (no jobs, so no finishedAt);
the scopes table lists every subnet of the estate (111 on the synthetic tenant) and will need paging on large estates;
business-unit tenants still need their Keycloak tenant claim set by hand (REQ-SEC-009). Lighthouse: setup 1.00; the
run also caught DCIM at 0.87 because checkpoint 10 had put the headline metric into the shared CI summary selection,
which every screen fetches; the summary is lean again and the metric is selected only where rendered (DCIM 0.91).

## Earlier session · 2026-11-01 (finish-everything marathon, checkpoint 10: headline metrics)

REQ-CMDB-038 done end to end (ADR-016, `docs/evidence/cmdb/headline-metrics.md`). Metric samples now have a path:
`CollectorResult.samples` (collector contract 0.2.0, Go `Samples` with omitempty on node and collectors) → the
reconciler binds each sample's CiRef to an id, drops the unresolvable, emits `openmap.metric.sampled` (event 0.2.0,
≤ `RECONCILER.samplesPerEvent` per envelope, pending for ClickHouse only) → the dispatcher writes `metrics` → migration
0003 keeps `metrics_latest` current → `Ci.headlineMetric` (GraphQL 0.8.0) through a per-request ClickHouse batch
loader (span + `openmap_clickhouse_queries_total`) → the console shows it on every CMDB row, the CI detail header,
focus-search hits and the impact panel (`metric.<key>` in en and ar, contract unit, "No sample yet"). The synthetic
estate emits one headline sample per CI of a known layer plus subnet utilisation and PDU power (rack name label), so a
replay fills `metrics` (28,501 samples at scale 0.05, 0 dropped) and `subnet_utilisation_daily` for the first time.
The API serves a 50-row page with headlines in 21–76 ms end to end. The persist transaction got an explicit budget
(`RECONCILER.persistTransactionTimeoutMs`, 120 s): Prisma's default 5 s expired on a 2,000-CI result on this host.
Replay procedure: stop the compose reconciler first, or its dispatcher claims the outbox with whatever its image has.
Observations: the headline is per layer, so subnets and IPs show device traffic (a per-type override is a follow-up);
`power_by_rack_hourly` keys on the rack CI id in `labels['rack_id']`, which collectors cannot know, so the view stays
empty until the reconciler resolves CI references inside sample labels (follow-up for REQ-DCIM power from telemetry).

## Earlier session · 2026-11-01 (finish-everything marathon, checkpoint 9: the assistant)

Syed reported the assistant answering every question with `the query failed to run: Unbound variable: n`. Root cause:
the grounding prompt carried the fragment `WHERE n.tenantId = $tenantId` and an impact pattern with `{name:$name}`;
the 1.5B model copied both verbatim. Fixed in REQ-AI-001 (`docs/evidence/assistant.md`): the prompt teaches from six
complete, validator-checked examples and the stored relationship directions; `prepareCypher` normalises hops (a
reversed known hop is turned round, a wrong type between two labels linked by one type is replaced), scopes every
MATCH-bound node variable to `$tenantId` and `validTo IS NULL` deterministically, adds the LIMIT; the validator rejects
unbound variables, unknown labels / relationship types / node properties, backwards hops and health literals outside
`HEALTH_STATES` (new in `@openmap/contracts`, mirroring the GraphQL enum) with a message that names the fix. Golden set
(T-113, `pnpm --filter @openmap/assistant test:integration`, picks the most populated tenant): 12/12 on
Qwen2.5-Coder-1.5B — 10 answered, 2 refused because utilisation and power draw are not graph properties. The e2e
Assistant test answers in en and ar on the rebuilt API image (`docs/evidence/console/assistant-{en,ar}.png`). The
console's example prompts for subnets and power now ask graph-answerable questions. `llm-cpu` in compose had the
image's health check on the wrong port (unhealthy for 499 checks); it has its own check now and reports healthy.
Observation for BSM: all 15 business services are `unknown` in the graph and in the API's `services` query on this
stack — the engine has had no CI health events since the estate replay (REQ-BSM-001/002 behaviour to revisit with a
synthetic event feed; not an assistant defect).

## Earlier session · 2026-11-01 (finish-everything marathon, checkpoint 8)

Syed asked for every Not started / In progress / In review row to be finished, dependencies on his side listed first,
easiest rows first. Commits this session: `6e6a055` (telemetry in every service, layer visibility on every list),
`12dab7e` (software, licence and vulnerability queries, GraphQL 0.5.0, ADR-013), `46aeaae` (Software and
Vulnerabilities screens; the services' missing OpenTelemetry dependency), `bb5e5b9` (dependency map force layout and
blast-radius isolation; licence dates as ISO instants; console lint debt cleared and linted in CI), `0d660e0` (CI short
codes unique in Postgres and editable, GraphQL 0.6.0, ADR-014; ClickHouse and Prometheus scrape fixes; layout-shift
fixes on Assets and Software; per-scope discovery rate limits honoured by the planner) and `3b6b9e8` (discovery
scopes: GraphQL 0.7.0, ADR-015; scopes card on the Discovery screen; knowledge graph refreshed).

**What exists and runs** (everything from checkpoint 7, plus):

- `apps/console`: **Software and licences** (`/software`: catalogue with footprint, licence usage and posture groups,
  text and licensed-only filter) and **Vulnerabilities** (`/vulnerabilities`: CVSS-ranked CVEs with exploited /
  exposure / CVSS filters and a blast-radius panel: affected software, hosts, business services with predicted
  state). Dependency map: lane/force layout toggle in the URL (`?layout=force`, deterministic Fruchterman-Reingold in
  the layout worker up to `DEPENDENCY_MAP.forceMaxNodes`), click isolates a node's impact closure (Sigma reducers dim
  the rest), double-click opens the CI. CI short codes come from the API (`Ci.code`), show on CMDB rows, focus-search
  hits and the CI detail header, where operators rename them (`setCiCode`). Assets and Software tables sit in
  fixed-height scroll regions (CLS was 0.31 / 0.27; Lighthouse under 0.9 on both until this change).
- `apps/api`: `software`, `vulnerabilitySummaries`, `vulnerability` (ADR-013); `Ci.code` and `setCiCode` (ADR-014,
  409 on a taken code); date attributes normalised with `isoAttribute()` (the estate stores calendar dates; the
  DateTime scalar rejected them and emptied the Software screen on the shipped image); discovery scopes carry
  `rateLimitConcurrency` / `rateLimitRps` subnet attributes that the planner honours under the Node ceiling.
- `packages/db`: migration `0010_ci_code_unique` renumbers duplicate codes (499 groups on the dev estate, every IP
  address had collapsed to `NET-10`), adds a BEFORE INSERT/UPDATE trigger that suffixes a taken code and a partial
  unique index on `("tenantId", code) WHERE "validTo" IS NULL`. `ciCode()` now keeps dotted non-domain names apart.
- `packages/telemetry` on every Node service; Prometheus scrapes api:4000, reconciler:4100, scheduler:4201,
  bsm-engine:4400 (all `up` after the container picked up the current scrape file); ClickHouse metrics on 9363 through
  `deploy/compose/clickhouse/prometheus.xml`; Memgraph Community has no Prometheus endpoint (target removed, documented).
  `docs/evidence/telemetry.md`.
- Lint: the console had 48 pre-existing lint errors that broke `next build` (the Docker console image); fixed, a `lint`
  script added, `pnpm lint` added to the CI verify job, Next/Playwright output ignored by ESLint. Other packages still
  lint only under the root config (apps/api has 65 findings under it, mostly the Nest empty-class rule) — see Next three.
- Evidence: `docs/evidence/console/{software,vulnerabilities,dependencies}-{en,ar}.png` and `screens.md`;
  `docs/evidence/telemetry.md`; e2e `30 passed, 1 skipped` on the final images (the scope test included); Lighthouse: 1.0 on
  every screen except dcim 0.91 and analytics 0.76 (embedded floor 0.7), CLS 0 on Assets and Software after the fix
  (`docs/evidence/perf/lighthouse.json` now records FCP, LCP, TBT, CLS, speed index and TTI per screen).

**Tracker.** The workbook was locked by Excel through checkpoints 4–9, so the closures were queued in
`.local/tracker-closures.sh` (gitignored) with their test ids and evidence. Syed closed Excel after checkpoint 9 and the
script ran: 50 rows moved to Done (CORE-014/015/016/017/018, SEC-002/006/007/008/010, IPAM-001/002/006, DCIM-002/009,
PERF-001/003, INT-003/004/005/006/007/008, CMDB-001…012, CMDB-030/031/035/037, DISC-029, UI-015/016, BSM-001/002/003,
DEP-003/005, AI-001/004, QA-002). `pnpm tracker status`: 88 of 188 Done (47%), 28 In progress, 4 In review, 68 Not
started, 0 Blocked; `pnpm tracker verify` ok. The earlier "56 rows / 94" figure in this file was an over-count; the
tracker is the truth.

## Dependencies on Syed (nothing below can be finished without them)

| Need | Rows blocked |
| --- | --- |
| `docs/SPEC.md` (the planning document exported as Markdown) | re-seeding the tracker; frozen contracts checked against it; every "per SPEC" acceptance criterion |
| Vendor lab or recorded transcripts (snmpwalk, SSH/CLI, WinRM, REST) for Cisco, Arista, Juniper, Dell iDRAC, HPE iLO, Lenovo, VMware, Hyper-V, Nutanix, Pure, NetApp, Dell EMC, Brocade/MDS, F5, Citrix, A10, APC, Liebert | REQ-DISC-001…027 Done (collectors exist, tested against protocol-shaped fixtures; R-004 forbids fabricating vendor data), REQ-QA-003 |
| Read-only cloud and SaaS credentials (AWS, Azure, GCP, OCI, Alibaba, Microsoft 365, Google Workspace, Salesforce, ServiceNow, Workday) | REQ-DISC-010, REQ-CMDB-022 Done |
| A GitHub remote (or other CI runner) so the `verify`, `integration`, `e2e` and `kind` jobs run | REQ-QA-002/004, REQ-INT-003 evidence from CI, REQ-PERF-002/004 thresholds "enforced in CI" |
| Warranty / EoX API credentials (Dell TechDirect, HPE, Lenovo, Cisco, IBM) | REQ-CMDB-024, REQ-INT-014 |
| Integration sandboxes (ServiceNow, Jira SM, Splunk/Sentinel, PagerDuty, Slack/Teams webhooks) | REQ-INT-009…017 Done beyond the recorded-fixture level |
| Corporate IdP (SAML/OIDC) and the MFA decision | REQ-SEC-009 Done |
| Decisions: ADR-006 (@peculiar/x509), ADR-007 (Sigma.js + graphology), per-business-unit tenancy, code-signing certificate for the release tarballs | REQ-SEC-013, REQ-SEC-010 scope, REQ-DISC-031/004 Done |

## In progress

- REQ-DISC-029 is complete in code (per-scope rate limits in the planner, `discoveryScopes` / `updateDiscoveryScope`
  in GraphQL 0.7.0 per ADR-015, the Discovery screen's scopes card with inline editing, T-010/T-067/T-112 and the e2e
  scope test); it moves to Done with the queued tracker closures. The scope builder now reads the CIDR from the subnet
  identity first: on the dev estate 106 of 107 subnets were invisible to a sweep before.
- REQ-CORE-013: scale-1 replay (550k CIs) on this 96 GB / 24-core machine and the concurrent-worker measurement.
- REQ-AI-001 is complete in code (golden set 12/12, T-011/T-113/T-104/T-106); it moves to Done with the queued
  tracker closures. Test files of apps/assistant and apps/api are excluded from their tsconfig, so the root ESLint
  project service cannot parse them (`pnpm exec eslint apps/assistant/src` reports only that); part of the lint item.
- REQ-SEC-009 (in review): SAML brokering and MFA need a corporate IdP.
- REQ-DISC-031 / REQ-DISC-004 (in review): signed release tarballs.
- Lint debt outside the console: add `lint` scripts to every package and clear the root-config findings.

## Blocked

- docs/SPEC.md still missing (risk R-001). Vendor lab fixtures (risk R-004). CI never ran (no remote).

## Next three

1. REQ-CORE-019 (OpenAPI for the REST surface and a generated SDK); REQ-PERF-002 k6 threshold wired into the e2e CI job; REQ-PERF-005 (platform health screen over the
   Prometheus metrics that now exist).
2. REQ-CORE-013 scale-1 replay; REQ-AI-002/003; REQ-UI-021/022/023 reports, DOQL, BI; a synthetic CI health event
   feed so the BSM engine propagates service health on the dev estate; paging for the setup scopes table.
3. Lint scripts for apps/api, apps/assistant and the remaining packages (their test files sit outside tsconfig, so the
   root ESLint project service cannot parse them); then the DISC rows that need no vendor lab (REQ-DISC-001 SNMP against
   the recorded fixtures already in packages/testing/fixtures).

**Dev-stack notes (also in project memory):** the compose stack is running (apps overlay, `cpu` LLM profile, `node`
profile); images `openmap/{api,console,scheduler,reconciler,bsm-engine}:dev` were rebuilt this session; migration 0010
is applied to the dev database. Lighthouse must run alone on the CPU. Smoke tokens for the synthetic tenant need a
Keycloak user whose `tenant` attribute is `ac9a6a65-1f19-4ecf-bf16-b3a90e42cc5c`.

## Questions for Syed

1. Export the planning document to `docs/SPEC.md` so the tracker can be re-seeded and the contracts frozen against it.
2. Access to the vendor lab (or recorded `snmpwalk`, SSH, WinRM, REST transcripts) for Cisco, Arista, Dell iDRAC, HPE
   iLO, VMware, Nutanix, Pure, NetApp, Brocade/MDS, F5, APC: nothing can be fabricated.
3. Confirm ADR-006 (`@peculiar/x509`) and ADR-007 (Sigma.js + graphology, MIT) as accepted dependencies; ADR-013 and
   ADR-014 are additive contract bumps (0.5.0, 0.6.0) recorded for review.
4. Confirm multi-tenancy is per business unit as drawn in onboarding.
5. Close the tracker workbook in Excel while sessions run (or we switch the tracker to a copy-on-write flow).
