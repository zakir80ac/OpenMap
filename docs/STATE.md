# OpenMap — build state

Read this first in every session (CLAUDE.md §2). If this file and the tracker disagree, the tracker wins.

## Last session · 2026-10-22 (kickoff)

**What exists**

- Repository scaffolded exactly as CLAUDE.md §5: pnpm workspaces, Turborepo, strict TypeScript, ESLint, Prettier, lefthook pre-commit (guard, tracker verify, i18n check, graphify update).
- `packages/constants` (every cross-deployment constant with rationale, perf budgets, guard token list), `packages/config` (zod env with documented defaults, tenant settings), `packages/i18n` (en + ar catalogues, parity check fails the build), `packages/contracts` (CI, collector, event, asset, impact, integration, organization schemas; 18 JSON Schemas emitted; GraphQL SDL 0.1.0).
- `tools/tracker` (ExcelJS CLI: init, add, set, status, next, report, verify, session) and `tools/guard` (forbidden tokens, unsafe types, literals, magic numbers, user-facing strings, REQ headers, perf budgets, tracker verify). Both unit-tested.
- `tracker/OpenMap-Tracker.xlsx` seeded with 180 requirements from CLAUDE.md, docs/CAPABILITY-MAP.md and the design canvas.
- `deploy/compose`: single-node stack (Postgres 17, Memgraph, ClickHouse, Valkey, Meilisearch, Keycloak with realm import, OpenBao, Superset with embedded config, vLLM GPU profile, llama.cpp CPU profile, OTel collector, Prometheus) plus the air-gap overlay.
- Docs: CONTRACTS.md (0.1.0 proposed), CAPABILITY-MAP.md (Device42 parity, 10 sections), ADR-001…005.
- Design: Obsidian Pro console canvas with 11 screens, two of them working prototypes (Impact modeling, Onboarding): https://claude.ai/artifact/VcFmJuAaHCmrvgpPMmTzrf

**Decisions taken this session** (see ADRs): Go for Node and collectors; contracts drafted without SPEC.md; twelve-layer model; infrastructure plans replace purchase orders.

## In progress

- REQ-CORE-001, 002, 005, 006 — contracts at 0.1.0 "proposed"; freeze when the reconciler and API consume them end to end.
- REQ-UI-001 — `packages/ui` tokens from the design canvas.
- REQ-INT-001, 002 — compose stack written; not yet brought up and smoke-tested on this machine.

## Blocked

- Go toolchain not installed on the build machine (risk R-002). `apps/node` and `apps/collectors` cannot compile until it is.
- docs/SPEC.md missing (risk R-001). Tracker seeded provisionally; re-run `pnpm tracker init` when it lands.

## Next three

1. REQ-CORE-009 — Prisma schema and migrations in `packages/db` (CIs, relationships, assets, plans, tenants, outbox, integrations, organization, sites, links), bitemporal columns.
2. REQ-CORE-012 — `apps/api` NestJS on Fastify with Mercurius serving `schema.graphql` against Postgres and Memgraph.
3. REQ-UI-001 then the console shell (`apps/console`) with the Obsidian Pro tokens, en/ar, RTL.

## Questions for Syed

1. Please export the planning document to `docs/SPEC.md` so the tracker can be re-seeded and the contracts frozen against it.
2. Install Go 1.23+ on the build machine, or confirm CI is the only place Go compiles.
3. Confirm the layer list (12) and the 31 integration vendors are complete for release one.
4. Confirm multi-tenancy is per business unit (as drawn in onboarding) rather than per legal entity.
