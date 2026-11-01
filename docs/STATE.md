# OpenMap — build state

Read this first in every session (CLAUDE.md §2). If this file and the tracker disagree, the tracker wins.

## Last session · 2026-11-01 (finish-everything marathon, checkpoint 10: headline metrics)

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

## Previous session · 2026-11-01 (finish-everything marathon, checkpoint 9: the assistant)

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
2. REQ-CORE-013 scale-1 replay; REQ-AI-002/003; REQ-UI-020/024 onboarding wizard; REQ-UI-021/022/023 reports, DOQL,
   BI; a synthetic CI health event feed so the BSM engine propagates service health on the dev estate.
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
