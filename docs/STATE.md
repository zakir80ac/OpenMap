# OpenMap — build state

Read this first in every session (CLAUDE.md §2). If this file and the tracker disagree, the tracker wins.

## Last session · 2026-11-05 (checkpoint 19: the conversational assistant, increment one)

**Done.** REQ-AI-007 (ADR-028 accepted for increment one). REQ-AI-008 stays In progress (increment two).

- **Understand** (`apps/assistant/src/core/vocabulary.ts`, `intent.ts`): a bilingual catalogue (CI types, attribute
  families with the keys collectors write, the ClickHouse measurements, aggregates, grouping words, intent markers,
  periods, health, names, scope words) classifies the question deterministically with the matched terms kept as
  evidence; the model (`llm-intent.ts`) is asked for a JSON verdict only below `ASSISTANT.minIntentConfidence` and
  can fill gaps, never override.
- **Plan** (`plan.ts`): intent → skill steps with typed parameters, or a clarification (`needName`, `unknown`);
  "VMs per host" maps the counterpart to the hypervisor; a non-numeric attribute becomes a breakdown.
- **Retrieve** (`apps/api/src/assistant/skills/*`): `cmdb.attributes` (Postgres SQL: count, breakdown, avg/sum/min/
  max, grouped aggregates, relationship fan-out density; attribute keys from the tenant's discovered catalogue,
  scope words resolved against low-cardinality values), `metrics.latest` (ClickHouse latest sample per CI,
  aggregate or ranking with names), `services.availability` and `incidents` (ADR-024 services module), `impact` and
  `history` (graph closure, CI versions), `howto` (screen catalogue in i18n), `graph.query` (REQ-AI-001 kept).
  Each step: timeout, span, evidence (store, query, params, rows, duration, error); ambiguous names narrow to the
  types the question used, then ask back with choices that re-ask using the CI code.
- **Compose** (`compose.ts`, `guard.ts`, `prose.ts`): every summary worded through the catalogue in en and ar with its
  figures; `ASSISTANT_PROSE` lets the model reword under the grounding guard (numbers at any rounding, identifiers in
  the evidence, sentence budget) and falls back with `grounded: false`.
- **Follow up** (`followups.ts`): three next questions per intent.
- **Contracts.** GraphQL 1.4.0 (`AssistantAnswer` intent/confidence/figures/evidence/followUps/clarification/
  grounded, `askAssistant(question, locale)`), event 0.5.0 (`openmap.assistant.query.failed`), assistant 0.1.0
  (`packages/contracts/src/assistant.ts`). Metrics `openmap_assistant_questions_total{intent,outcome}`,
  `openmap_assistant_duration_seconds`.
- **Console.** `AssistantView` shows prose, intent and confidence, figures (Kpi), CI pills, evidence per step,
  Cypher and rows when a graph step ran, follow-up chips, clarification choices, the ungrounded note; the Impact
  screen passes the locale. 193 i18n keys per locale.
- **Evaluation.** `apps/assistant/src/eval/questions.ts` (29 questions, en and ar, Syed's two failures included),
  run offline by T-142 and through GraphQL against the stack by T-143 (`apps/api/src/assistant/
assistant.eval.integration.test.ts`): 29 of 29 through GraphQL in 45 s, English prose grounded, Arabic deterministic (ASSISTANT_PROSE_LOCALES=en on the CPU profile). Console T-144; e2e Assistant: 3 of 3 (setup, en, ar); Lighthouse: not re-measured (the Assistant screen carries no budget; the budgeted screens are untouched).
  Evidence: `docs/evidence/assistant-conversation.md`.

**Lessons.** (1) Parameterised SQL keeps the attribute key in `$n` bindings: evidence checks must read params too.
(2) A hypervisor and its host share a name in the synthetic estate: resolve names by the types the question named
before asking back. (3) Arabic accusative endings ("جهازاً افتراضياً") need per-word suffixes in the term matcher.
(4) The graphify commit hook (`--no-cluster`, `stage_fixed`) commits the raw graph.json; the curated report is ours.

## Previous session · 2026-11-05 (checkpoint 18: uptime tile, register pages, subscription cover, assistant ADR)

**Done.** REQ-UI-036, REQ-CMDB-041, REQ-CMDB-042; ADR-027 accepted; ADR-028 proposed for REQ-AI-007/008.

- **Uptime tile (REQ-UI-036).** Widget kind `services.uptime`: the estate's availability this month weighted by
  observed minutes over the monthly availability report, the change against last month, services below target.
  First on the admin and CTO/CIO templates; migration 0017 inserted it first on existing dashboards of those
  personas. `estateAvailability()` in `dashboard/widgets.tsx`.
- **Register pages (REQ-CMDB-041).** `assetPage(filter, page, pageSize)` (GraphQL 1.2.0) with totals; the console
  keeps the page in the URL, resets on filter change, shows the error of a failed page. The cursor query stays.
- **Subscription cover (REQ-CMDB-042, ADR-027).** `subscriptionSchema` (provider, plan, start, end, credits with
  unit/currency/asOf, source) on `asset_records.subscription` (migration 0018 with backfill from CI attributes);
  `SUBSCRIPTION_CI_TYPES` take the `subscription` gap instead of `warranty`; GraphQL 1.3.0 (`SubscriptionCover`,
  `Credits`, `SubscriptionInput`, `AssetSummary.subscriptionExpired`); the reconciler sync, the labelling path and
  the manual form carry it; the details form shows the subscription group for those types. Collectors: Microsoft
  365 reads `directory/subscriptions` for the term per SKU; Azure reads the billing account and the credit balance;
  both tested with protocol-shaped stand-ins. Google, Salesforce, ServiceNow, Workday, AWS, GCP, OCI, Alibaba have no
  read API for terms or balances: manual entry, documented in the ADR. The synthetic estate emits terms on licences
  and a term plus credits on cloud accounts.
- **Assistant (ADR-028, proposed).** Conversation records, five levels (understand → plan → retrieve across Postgres,
  Memgraph, ClickHouse → compose with a numeric grounding guard → follow-ups and clarifications), skills for
  attribute statistics, measurements, availability, incidents, impact, history and how-to, a checked-in evaluation
  set in CI. "Trained for OpenMap" is the catalogue, examples and evaluation set, not weights; LoRA is the documented
  later step once a GPU host exists. Increment one is REQ-AI-007, increment two REQ-AI-008.
- **Tracker.** Rows REQ-UI-036, REQ-CMDB-041, REQ-CMDB-042, REQ-AI-008 added; the `next` list still leads with the
  old P0 discovery rows because 26 DISC rows sit "In progress" since the collector marathon; that is a prioritisation
  question for Syed (below).
- **Tests.** Console 239 (35 files), API integration 22/22, contracts 14, reconciler 6+20, synth 8, Go saas/azure ok,
  e2e assets + dashboard: assets 3/3 (pager, subscription save), dashboard 3/3 (uptime tile); Lighthouse: assets 0.97/1.0/1.0, dashboard 0.99/1.0/1.0. Evidence: `docs/evidence/dashboard-uptime-register.md`,
  `docs/evidence/console/{dashboard-uptime,assets-subscription}-{en,ar}.png`.

**Lessons.** (1) Playwright `isVisible({ timeout })` ignores the timeout: use `waitFor({ state: 'visible' })`.
(2) A generated end-marker insertion lands in whichever test precedes the marker; anchor on the test being extended.
(3) The console's `Kpi` prints value and unit in one text node: match by prefix in tests.

## Earlier session · 2026-11-05 (checkpoint 17: SLA assignment, uptime by period, incident response with RCA)

**Done.** REQ-BSM-006 and REQ-BSM-008 (ADR-024), plus the register paging fix (cf5a4c0).

- **History has one store.** The reconciler's dispatcher now writes every `openmap.bsm.health.changed` event as a
  `service_health_history` row (ClickHouse DDL 0004 back-filled the 12 earlier events); the API and the engine read
  availability from that table only. `@openmap/bsm-engine` gained the pure arithmetic (`core/availability.ts`:
  windows, unknown time out of the denominator, calendar months/quarters/years cut at local midnight in the tenant's
  zone, budgets and burn rate; `core/history.ts`: the shared ClickHouse reader) and the SLA decisions
  (`service/sla.ts`: breach incident once per window, at-risk alert at the burn-rate threshold, roll-over clear,
  response and resolution deadlines and misses).
- **SLAs are rows.** Prisma 0016: `slas`, `service_sla_assignments` (one per service), and on `incidents` the
  assignee, `slaId`, `respondBy`/`resolveBy`, the breach stamps, `closedAt`, `resolutionNote` and the RCA JSON. The
  engine evaluates every assigned service each tick (`evaluateSlas`, new metrics `openmap_bsm_sla_evaluations_total`,
  `openmap_bsm_sla_evaluation_duration_seconds`) and stamps missed targets on every open incident, delivering
  `incident.updated` to subscribed integrations.
- **API.** GraphQL 1.1.0 (additive): `Sla`, `AvailabilityPeriod`, `ServiceAvailability`, `Rca`, `IncidentEvent`,
  `ServiceHealth.sla`/`currentWindow`/`availability`, the full `Incident`, queries `service`, `incident`, `slas`,
  `availabilityReport`, `availabilityReportCsv`, mutations `assignIncident`, `resolveIncident`, `closeIncident`,
  `updateIncidentRca`, `upsertSla`, `deleteSla`, `assignSla`; event 0.4.0 adds `openmap.bsm.sla.at_risk`. The
  incident timeline merges audit entries (the global interceptor records every mutation) with the engine's events.
  `BsmFactsService.slaFor` moved from the outbox to the history; `Query.incidents` takes `serviceId`.
- **Console.** Business services: SLA select per row, window figure ("99.2% this month") in the met/missed tone,
  burn rate; the Uptime table (month / quarter / year, "to date", "Missed" tags, Export CSV); the SLA catalogue with
  create/edit/delete; incident cards with severity, state, deadlines, assignee, acknowledge / assign / resolve /
  close, the RCA form and the timeline; `/services/[id]` detail route. 118 new i18n keys in en and ar.
- **Synthetic history.** `synth-estate health-history` (deterministic outages per service and month) and
  `reconciler replay-history` (back-dated health events through the outbox plus resolved incidents with deadlines).
  The dev tenant carries 14 months for its 15 services (398 rows, 199 incidents); the 300-service k6 measurement used
  a temporary perf fixture (284 seeded services, 7,884 events) that was removed afterwards.
- **Tests.** T-132 availability (12), T-133 SLA decisions (6), T-134 synthetic history (3), dispatcher health rows,
  T-135 API integration (22/22 whole suite), T-136 ServicesView (15), T-137 ServiceDetailView (4), T-138 e2e
  `services.spec.ts` en+ar (3/3), k6 `availability-report.js` p95 629 ms on 299 services (budget 1,000 ms), guard ok,
  `contracts:check` ok, i18n in sync, Lighthouse on Services 1.0/1.0/1.0 with CLS 0 (fixed-height scroll regions
  for the list and the uptime table, as on Assets). Evidence: `docs/evidence/sla-uptime.md`, `docs/evidence/console/services-*.png`.

**Lessons.** (1) `@clickhouse/client` binds `{p:DateTime64(3)}` params as String: cast in SQL
(`toDateTime64({p:String}, 3, 'UTC')`). (2) A SELECT alias named like a column (`toString(ts) AS ts`) shadows the
column in WHERE. (3) Two outbox dispatchers (the compose reconciler and a local `replay-history`) both claim the same
pending rows: the claim is read-then-update, not `FOR UPDATE SKIP LOCKED`; stop one before running the other (noted
under In progress for REQ-CORE-013). (4) `docker compose build` once produced no new image at all (same ids); run it
with `--progress=plain` to a log and compare image ids before `--force-recreate`. (5) Guard reads
`=> Promise<...>` on one .tsx line as JSX text: callback types live in `components/services/types.ts`. (6) k6 v2
consolidates `options` in `handleSummary`: read the VU count from `__ENV`.

## Earlier session · 2026-11-05 (checkpoint 16: the asset register follows the CMDB)

Syed's next statement: asset management must show everything the organisation owns across every layer plus the
unknown devices (with remediation or manual entry where a device has no out-of-band management), every asset with
warranty, support and end-of-life dates; then SLA assignment with continuous monitoring, alerting, incident response,
audit and RCA; then sites and their connectivity for HA/DR; later in the session: best-in-class uptime monitoring by
month, quarter and year, and the assistant to be grounded so it stops failing on questions like "OS per server
average" or "VMs per host" (REQ-BSM-008, REQ-AI-007 added). Done this session, ADR-023 (REQ-CMDB-039, REQ-CMDB-040):
the asset contract names the owned CI types; the reconciler creates one register row per owned CI in the same
transaction as the CI and refreshes what discovery observes on later sweeps without touching a person's entries
(array statements, tag fallback, unique per CI); migration 0015 backfilled the dev estate (9,481 rows: 2,000 hosts
with vendor warranty, 252 network devices, 26 licences with their expiry as subscription cover, 7,200 rows with at
least one gap); the API gained `assetSummary`, `assets(filter:)` (layer, type, stage, source, data gap, text),
`updateAsset` (audited per field, `openmap.asset.updated`) and `createAsset` (a CI through the outbox plus the row,
`openmap.asset.created`); labelling an unknown CI into an owned type registers it at once. The Assets screen is the
register per layer (strip with counts and gap counts, filters, cover columns with missing/expired tones, a details
panel with audit trail), the attention table, unknown devices with a rule-based diagnosis (`diagnoseUnknown`:
stale, SNMP power gear, SNMP device, unknown service on a non-standard port, no management, web-only endpoint) that
opens the label panel preset, manual entry for unmanaged equipment, and the plans. GraphQL is 1.0.0 (manufacturer
and model nullable is breaking), asset 0.2.0, event 0.3.0. Tests: T-127 (reconciler mapping), T-128 (diagnosis),
T-100 (view, en/ar), T-129 (e2e, en/ar), T-130 (API integration), T-131 (reconciler sync against Postgres).
Lessons: Python `write_text` on Windows turns LF into CRLF — write bytes; the i18n package must be rebuilt before the
console typecheck sees new keys; `pnpm contracts:check` reads the committed schema, so a breaking change needs the
major bump before the check passes. ClickHouse `ci_history.source_run_id` is a UUID column: a CI the API creates
must carry a UUID run id (the manual asset first stamped the literal `manual-asset`, and the one event poisoned every
ClickHouse batch of the dispatcher until it was fixed and the leftover test tenant purged). Docker Desktop's WSL engine
died during an image build and had to be restarted by hand; containers came back on their old images until recreated.

## Earlier session · 2026-11-05 (checkpoint 15: the Layers equipment scene and the formal profile)

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

## Earlier session · 2026-11-04 (checkpoint 14: dashboard wizard, role templates, Horizon refinements)

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

| Need                                                                                                                                                                                                                      | Rows blocked                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `docs/SPEC.md` (the planning document exported as Markdown)                                                                                                                                                               | re-seeding the tracker; frozen contracts checked against it; every "per SPEC" acceptance criterion                                   |
| Vendor lab or recorded transcripts (snmpwalk, SSH/CLI, WinRM, REST) for Cisco, Arista, Juniper, Dell iDRAC, HPE iLO, Lenovo, VMware, Hyper-V, Nutanix, Pure, NetApp, Dell EMC, Brocade/MDS, F5, Citrix, A10, APC, Liebert | REQ-DISC-001…027 Done (collectors exist, tested against protocol-shaped fixtures; R-004 forbids fabricating vendor data), REQ-QA-003 |
| Read-only cloud and SaaS credentials (AWS, Azure, GCP, OCI, Alibaba, Microsoft 365, Google Workspace, Salesforce, ServiceNow, Workday)                                                                                    | REQ-DISC-010, REQ-CMDB-022 Done                                                                                                      |
| A GitHub remote (or other CI runner) so the `verify`, `integration`, `e2e` and `kind` jobs run                                                                                                                            | REQ-QA-002/004, REQ-INT-003 evidence from CI, REQ-PERF-002/004 thresholds "enforced in CI"                                           |
| Warranty / EoX API credentials (Dell TechDirect, HPE, Lenovo, Cisco, IBM)                                                                                                                                                 | REQ-CMDB-024, REQ-INT-014                                                                                                            |
| Integration sandboxes (ServiceNow, Jira SM, Splunk/Sentinel, PagerDuty, Slack/Teams webhooks)                                                                                                                             | REQ-INT-009…017 Done beyond the recorded-fixture level                                                                               |
| Corporate IdP (SAML/OIDC) and the MFA decision                                                                                                                                                                            | REQ-SEC-009 Done                                                                                                                     |
| Decisions: ADR-006 (@peculiar/x509), ADR-007 (Sigma.js + graphology), per-business-unit tenancy, code-signing certificate for the release tarballs                                                                        | REQ-SEC-013, REQ-SEC-010 scope, REQ-DISC-031/004 Done                                                                                |

## In progress

- REQ-DISC-029 is complete in code (per-scope rate limits in the planner, `discoveryScopes` / `updateDiscoveryScope`
  in GraphQL 0.7.0 per ADR-015, the Discovery screen's scopes card with inline editing, T-010/T-067/T-112 and the e2e
  scope test); it moves to Done with the queued tracker closures. The scope builder now reads the CIDR from the subnet
  identity first: on the dev estate 106 of 107 subnets were invisible to a sweep before.
- REQ-CORE-013: scale-1 replay (550k CIs) on this 96 GB / 24-core machine and the concurrent-worker measurement.
  The outbox claim in `dispatchOnce` is read-then-update: two dispatchers on one database both deliver the same
  rows (seen with the compose reconciler and a local `replay-history`); a `FOR UPDATE SKIP LOCKED` claim belongs to the
  multi-worker measurement.
- REQ-AI-001 is complete in code (golden set 12/12, T-011/T-113/T-104/T-106); it moves to Done with the queued
  tracker closures. Test files of apps/assistant and apps/api are excluded from their tsconfig, so the root ESLint
  project service cannot parse them (`pnpm exec eslint apps/assistant/src` reports only that); part of the lint item.
- REQ-SEC-009 (in review): SAML brokering and MFA need a corporate IdP.
- REQ-DISC-031 / REQ-DISC-004 (in review): signed release tarballs.
- Lint debt outside the console: add `lint` scripts to every package and clear the root-config findings.

## Blocked

- docs/SPEC.md still missing (risk R-001). Vendor lab fixtures (risk R-004). CI never ran (no remote).

## Next three

1. REQ-AI-008 (ADR-028 increment two): persisted conversations (`assistant_conversations`, `assistant_turns`,
   Prisma migration), follow-up resolution against the previous turn's entities and period ("and last month?"),
   the conversation list in the console, `metrics.series` for ranges, LoRA step documented once a GPU host exists.
2. REQ-BSM-007 (ADR-025): sites and connectivity for HA/DR readiness.
3. Finance module (costing, ROI, cost management, planning, budgeting): tracker rows to add, then build.

**Dev-stack notes (also in project memory):** the compose stack is running (apps overlay, `cpu` LLM profile, `node`
profile); images `openmap/{api,console,scheduler,reconciler,bsm-engine}:dev` were rebuilt this session; migrations through 0018
and ClickHouse DDL through 0004 are applied to the dev database. Lighthouse must run alone on the CPU. Smoke tokens for the synthetic tenant need a
Keycloak user whose `tenant` attribute is `ac9a6a65-1f19-4ecf-bf16-b3a90e42cc5c`.

## Questions for Syed

0a. Tracker priority: 26 discovery rows (REQ-DISC-003…031) have been "In progress" since the collector marathon
and still head `pnpm tracker next`. Should they move to "In review" (collectors exist, vendor fixtures pending on
the lab) so the next list shows the SLA, assistant and finance work you asked for?
0b. Microsoft 365 and Azure: grant the read-only app registration `Organization.Read.All` (Graph) and a Billing
Reader role on the billing account so the subscription term and credit balance flow in; Google Workspace terms
need the Reseller API only if Workspace is bought through a reseller. 0. Analytics: the embedded Superset frame, once fully loaded, scores 0.67 on Lighthouse performance whatever the
console does around it (its own 2.7 MB of script; ADR-026 lowered the embedded floor to 0.65 to state the cost).
Should the Analytics screen become native ClickHouse charts in the console (REQ-UI-021/022/023 reports and BI)
with Superset kept for ad-hoc exploration only? That is the only way to the 0.90 budget on that screen.

1. Export the planning document to `docs/SPEC.md` so the tracker can be re-seeded and the contracts frozen against it.
2. Access to the vendor lab (or recorded `snmpwalk`, SSH, WinRM, REST transcripts) for Cisco, Arista, Dell iDRAC, HPE
   iLO, VMware, Nutanix, Pure, NetApp, Brocade/MDS, F5, APC: nothing can be fabricated.
3. Confirm ADR-006 (`@peculiar/x509`) and ADR-007 (Sigma.js + graphology, MIT) as accepted dependencies; ADR-013 and
   ADR-014 are additive contract bumps (0.5.0, 0.6.0) recorded for review.
4. Confirm multi-tenancy is per business unit as drawn in onboarding.
5. Close the tracker workbook in Excel while sessions run (or we switch the tracker to a copy-on-write flow).
