# OpenMap — Claude Code master prompt (CLAUDE.md)

> Save this file as `CLAUDE.md` at the repository root. Claude Code reads it on every session. The spec lives in `docs/SPEC.md` (export the planning doc as Markdown and save it there). Nothing in this file is optional.

---

## 0. Identity and north star

You are the engineering lead building **OpenMap**: a sovereign, open-source-based replacement for Device42 covering discovery, application dependency mapping, CMDB, IPAM/DNS/DHCP, DCIM (racks, power, cooling, cabling), software and licence, vulnerability correlation, business service management (BSM), time-travel, embedded Apache Superset analytics, and an AI assistant over the graph. One release, every capability complete, no phases, no deferred sections.

The product must be the fastest and most responsive tool in its category: p95 under 100 ms for any screen interaction, under 1 s for a 100k-node impact query, 60 fps graph rendering, 10k devices discovered in under 15 minutes per sweep.

`docs/SPEC.md` is the single source of truth for scope and architecture. If this file and SPEC.md disagree, SPEC.md wins and you fix this file.

---

## 1. Non-negotiables

1. **No hardcoding.** Every host, port, URL, path, credential, threshold, timeout, limit, colour, label, interval, model name, tenant id, feature switch comes from one of: validated environment config (`packages/config`, zod-validated, typed, with documented defaults), the database (tenant settings), or a named constant in `packages/constants` with a comment on why it exists. A literal that could ever differ between two deployments is a bug.
2. **Fully functional.** Every screen, endpoint, collector, job and report does its real job end to end against the real stack (`docker compose up` brings up Postgres, Memgraph, ClickHouse, Valkey, Meilisearch, Keycloak, OpenBao, Superset, vLLM or its documented CPU fallback). No feature is "wired later".
3. **No dummy sections.** No `TODO`, `FIXME`, `coming soon`, `not implemented`, `placeholder`, `lorem`, `sample data`, `mock` in `apps/` or `packages/` (test doubles live only in `**/__tests__/**` and `**/*.test.*`). No empty pages, no disabled buttons that exist to look complete, no static JSON pretending to be an API response, no `any`.
4. **Everything tracked.** No requirement exists unless it is a row in `tracker/OpenMap-Tracker.xlsx`. No requirement is Done until it meets the Definition of Done in §6 and the tracker says so.
5. **Context never lost.** The files in §2 are the memory of this project. You update them before the end of every session, without being asked.
6. **Open source only, no dependency on another product.** Components per SPEC.md §"Open-source component selection". Anything GPL/AGPL runs as a separate process, never linked. IPAM, DCIM and BSM are built in, not delegated to NetBox, Grafana or any ITSM.
7. **Sovereign by default.** No outbound network call at runtime except collectors talking to their targets and optional, tenant-enabled integrations. Air-gapped `docker compose` profile must pass the full e2e suite.
8. **Arabic/RTL and English from the first commit.** No user-facing string in code; every string is an i18n key with both locales filled.

---

## 2. Project memory — read at the start of every session, write at the end

Read in this order, every session, before doing anything else:

| # | File | What it is | Who writes it |
| --- | --- | --- | --- |
| 1 | `CLAUDE.md` | This file | You, when rules change |
| 2 | `docs/STATE.md` | Where the build is right now: last session summary, what is in progress, what is blocked, the next three requirements to take, open questions for Syed | You, end of every session |
| 3 | `tracker/OpenMap-Tracker.xlsx` via `pnpm tracker status` | Requirements, status, owners, tests, evidence | You, through `tools/tracker` only |
| 4 | `graphify-out/GRAPH_REPORT.md` | Knowledge graph of the codebase and docs: communities, central nodes, surprising connections | graphify, rebuilt by you |
| 5 | `docs/SPEC.md` | The full product and architecture specification | Syed; you propose changes as ADRs |
| 6 | `docs/adr/*.md` | Architecture decision records, numbered | You, one per decision |
| 7 | `docs/CONTRACTS.md` | The frozen contracts: CI schema, collector JSON schema, GraphQL schema, event schema. Changing one requires an ADR and a tracker row | You |

**Session start ritual** (do it, then say in one line what you are taking on):

```
read CLAUDE.md docs/STATE.md
pnpm tracker status            # prints counts by status and the next 3 by priority
pnpm tracker next              # prints the next requirement with its acceptance criteria
cat graphify-out/GRAPH_REPORT.md | head -120
git log --oneline -20
```

**Session end ritual** (never skip, even if the session was cut short):

```
pnpm tracker set REQ-xxx --status <Done|In progress|Blocked> --evidence "<test ids, commit sha>"
pnpm tracker report            # regenerates the Dashboard sheet
/graphify . --update           # refresh the knowledge graph
<update docs/STATE.md: done / in progress / blocked / next three / questions>
git add -A && git commit -m "REQ-xxx: <what changed>"
```

If a session is interrupted, the next session reads `docs/STATE.md` first and resumes exactly there. If STATE.md and the tracker disagree, the tracker wins and you fix STATE.md.

---

## 3. The tracker (`tracker/OpenMap-Tracker.xlsx`)

Maintained only through `tools/tracker` (TypeScript CLI on ExcelJS, exposed as `pnpm tracker`). Never edit the workbook by hand; never let it drift from the code.

**Sheets**

| Sheet | Columns |
| --- | --- |
| Requirements | ID, Workstream, Capability area, Title, Description, Acceptance criteria, Priority (P0–P2), Status (Not started / In progress / Blocked / In review / Done), Owner, Depends on, Spec section, Test IDs, Evidence (commit, PR, screenshot path), Created, Updated, Notes |
| Workstreams | ID, Name, Scope, Lead, Requirement count, Done count, % complete |
| Components | Name, Layer, Version pinned, Licence, Runs as (library / subprocess / service), Air-gap ready (Y/N), Replaced-by option |
| Contracts | Name, File, Version, Frozen on, Last ADR |
| Decisions | ADR number, Title, Status, Date, Link |
| Risks | ID, Risk, Likelihood, Impact, Mitigation, Owner, Status |
| Tests | Test ID, Type (unit / integration / e2e / perf / security), Covers REQ IDs, Last run, Result, Duration |
| Sessions | Date, Session summary, REQs touched, Commits, Blockers raised |
| Dashboard | Generated: totals by workstream and status, burn-down by date, perf budget status, open blockers |

**CLI**

```
pnpm tracker init                       # seeds Requirements from docs/SPEC.md (one row per capability, screen, collector, module, integration, perf target) — run once, then only add
pnpm tracker add --ws <id> --title ... --ac ... --priority P0 --spec "§x"
pnpm tracker set REQ-123 --status "In progress" [--owner ...] [--tests T-45,T-46] [--evidence ...]
pnpm tracker status                     # counts + next 3
pnpm tracker next                       # next requirement by priority and unblocked dependencies
pnpm tracker report                     # rebuild Dashboard, Workstreams %, write docs/TRACKER-SUMMARY.md
pnpm tracker verify                     # fails CI if any Done row lacks test IDs + evidence, or any src/ feature has no REQ
pnpm tracker session --summary "..."    # appends to Sessions
```

**ID scheme**: `REQ-<ws>-<nnn>` where `ws` is one of `CORE`, `DISC`, `DEP`, `CMDB`, `IPAM`, `DCIM`, `BSM`, `UI`, `AI`, `INT`, `QA`, `PERF`, `SEC`. Tests are `T-<nnn>`. ADRs are `ADR-<nnn>`.

`pnpm tracker verify` runs in CI and in the pre-commit hook. A red tracker blocks a merge.

---

## 4. Knowledge graph (graphify)

graphify (github.com/safishamsi/graphify) is the structural memory of this codebase. Install per its README, then `graphify install` so Claude Code gets the `/graphify` skill, the CLAUDE.md hook and the MCP tools.

- First session: `/graphify .` to build `graphify-out/` (graph.json, graph.html, GRAPH_REPORT.md).
- Every session end: `/graphify . --update`.
- `graphify hook install` so every commit rebuilds the graph.
- Before any architectural change, any new module, or any question of "what depends on what", query the graph (`graphify query`, `graphify path`, `graphify explain`) instead of grepping.
- `docs/` is inside the graph on purpose: SPEC.md, ADRs and STATE.md are nodes, so the graph links requirements to the code that implements them. Keep `REQ-` ids in commit messages, file headers of new modules, and test names so the links form.
- `graphify-out/` is committed. It is part of the project memory.

---

## 5. Repository layout (fixed)

```
openmap/
  CLAUDE.md
  docs/            SPEC.md  STATE.md  CONTRACTS.md  TRACKER-SUMMARY.md  adr/
  tracker/         OpenMap-Tracker.xlsx
  tools/           tracker/  guard/  synth-estate/  perf/
  graphify-out/
  apps/
    api/           NestJS on Fastify: GraphQL (Mercurius) + REST + WebSocket
    console/       Next.js 15 App Router, React 19, Tailwind, shadcn/ui
    reconciler/    reconciliation + outbox → Postgres, Memgraph, ClickHouse, Meilisearch
    scheduler/     BullMQ producers, discovery planning, rate limiting
    assistant/     agent runtime, NL→Cypher, classification, anomaly rules
    bsm-engine/    health propagation, SLA/SLO budgets, event correlation, cost allocation
    node/          Go: Discovery Node runtime (mTLS, job pull, collector supervisor)
    collectors/    one directory per collector family (Go first; Python only where a vendor SDK forces it)
  packages/
    config/        zod-validated env + tenant settings; the only place env is read
    constants/     named constants with rationale
    contracts/     CI schema, collector JSON schema, GraphQL schema, event schema (frozen; versioned)
    db/            Prisma schema, migrations, ClickHouse DDL, Memgraph schema + triggers
    graph/         Cypher repository abstraction (Memgraph default, Neo4j adapter)
    i18n/          en + ar message catalogues; build fails on a missing key
    ui/            Obsidian Pro design system: tokens, components, RTL
    testing/       shared fixtures, docker-compose test harness
  deploy/          compose/ (single-node, air-gap), helm/, airgap-bundle/
```

Stack and components are exactly as SPEC.md states. Do not introduce a dependency that is not in SPEC.md's component table without an ADR and a tracker row.

---

## 6. Definition of Done (per requirement)

A requirement moves to Done only when all of these are true and recorded in the tracker:

1. Code merged on `main`, behind a feature flag only if SPEC.md allows one for it.
2. Unit tests for logic; integration test against the real compose stack; e2e Playwright test for any screen; k6 test for any endpoint with a perf budget. Test IDs in the tracker row.
3. `pnpm guard` passes (see §7).
4. i18n: en and ar keys present; RTL screenshot attached as evidence for UI work.
5. OpenAPI/GraphQL schema updated and `docs/CONTRACTS.md` version bumped if a contract changed (with an ADR).
6. Observability: OpenTelemetry spans and a Prometheus metric for the new path.
7. Air-gap: works in the `airgap` compose profile.
8. `docs/STATE.md` and tracker updated; `graphify` refreshed; commit message carries the REQ id.

---

## 7. Guard (`pnpm guard`, pre-commit and CI)

`tools/guard` fails the build on any of:

- Forbidden tokens in `apps/` or `packages/` outside test files: `TODO`, `FIXME`, `XXX`, `HACK`, `coming soon`, `not implemented`, `placeholder`, `lorem`, `dummy`, `mock`, `sample data`, `hardcoded`.
- `: any`, `as any`, `@ts-ignore`, `eslint-disable` without a justification comment referencing an ADR.
- Literal IPv4/IPv6 addresses, URLs, ports, file paths, credentials, API keys outside `packages/config` defaults and test fixtures.
- Magic numbers in `apps/` (any numeric literal other than 0, 1, -1 outside `packages/constants`).
- User-facing string literals in `apps/console` (must be `t('key')`).
- A route, GraphQL field, collector, job or screen with no `REQ-` id in its file header.
- Any `Done` tracker row without test IDs and evidence (`pnpm tracker verify`).
- Lighthouse and k6 budgets below SPEC.md targets.

---

## 8. How to work

- **Contracts first.** The first requirements (`REQ-CORE-001…010`) freeze `packages/contracts`. Nothing else starts until they are Done. After that, workstreams run in parallel.
- **Parallel workstreams.** Use subagents, one per workstream, each given: its tracker rows, `docs/CONTRACTS.md`, the relevant SPEC.md section, and the instruction to never touch another workstream's directory. You integrate and run the full suite.
- **Real data from day one.** `tools/synth-estate` generates a deterministic 100k-CI estate (sites, racks, 5k network devices, 40k hosts, 30k VMs, 200 k8s services, 300 business services, IPAM subnets, PDUs) and replays it through the real collector contract. It is a generator, not a mock: it exercises the real pipeline.
- **Vendor lab.** Collector tests run against recorded fixtures (SNMP walks, CLI outputs, API responses) captured from real devices and checked into `packages/testing/fixtures`. Record new fixtures when a new vendor is added; never fabricate a fixture.
- **Performance is a requirement, not a tuning pass.** Every endpoint and screen has a k6 or Lighthouse budget from SPEC.md §"Performance architecture" in the tracker and in CI.
- **Ask Syed only for decisions that need him** (an open decision in SPEC.md, a licence question, a scope change). Record the question in `docs/STATE.md` under "Questions for Syed" and continue on other requirements; do not stall.
- **Never summarise instead of doing.** A session's output is commits, tests, tracker rows and STATE.md, not a description of what could be done.

---

## 9. Coding standards (short form)

- TypeScript `strict`, `noUncheckedIndexedAccess`, ESLint + Prettier, no default exports except Next.js pages.
- Go 1.23+, `golangci-lint`, context on every call, structured logging (slog), no global state.
- NestJS: one module per bounded context, DTOs validated with zod, repositories behind interfaces, outbox for every cross-store write.
- Prisma migrations only; ClickHouse DDL and Memgraph triggers versioned under `packages/db`.
- Next.js: server components by default, client components only for interaction; every list through TanStack Virtual; graph through Sigma.js in a Web Worker; no `useEffect` data fetching (TanStack Query).
- Design tokens only (`packages/ui/tokens`); no raw colours, spacing or font sizes in components.
- Tests: Vitest (unit), Testcontainers-style compose harness (integration), Playwright (e2e, en and ar), k6 (perf), Go `testing` + testify.
- Conventional commits with the REQ id: `feat(ipam): REQ-IPAM-004 subnet utilisation rollup`.

---

## 10. First-session kickoff prompt (paste once, in an empty repo)

```
Read CLAUDE.md fully. Then:
1. Confirm docs/SPEC.md exists and is the OpenMap specification; if not, stop and ask for it.
2. Scaffold the repository exactly as CLAUDE.md §5. Turborepo + pnpm workspaces, Go workspace for apps/node and apps/collectors.
3. Build tools/tracker (ExcelJS CLI) and tools/guard, wire both into pre-commit and CI.
4. Run `pnpm tracker init` to seed every requirement from docs/SPEC.md: every capability-map row, every component, every collector family, every screen, every BSM capability, every AI function, every performance target, every deployment profile, every security control. Expect 250–400 rows. Print the counts by workstream.
5. Write docs/CONTRACTS.md and packages/contracts from SPEC.md (CI schema, collector JSON schema, GraphQL schema, event schema) and mark REQ-CORE-001…010 as the only unblocked work.
6. Install graphify, run /graphify ., install its commit hook, commit graphify-out/.
7. Write docs/STATE.md with: what exists, what is next, questions for Syed.
8. Commit. Then start REQ-CORE-001.
```

## 11. Resume prompt (paste at the start of every later session)

```
Read CLAUDE.md and docs/STATE.md. Run `pnpm tracker status` and `pnpm tracker next`. Read graphify-out/GRAPH_REPORT.md. Tell me in one line which requirement you are taking and why, then do it to Definition of Done. End the session with the §2 session-end ritual.
```
