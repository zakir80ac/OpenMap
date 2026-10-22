# OpenMap — build state

Read this first in every session (CLAUDE.md §2). If this file and the tracker disagree, the tracker wins.

## Last session · 2026-10-22 (kickoff marathon)

**What exists and runs**

- Monorepo per CLAUDE.md §5 (pnpm, Turborepo, strict TS, lefthook), Go workspace for `apps/node` and `apps/collectors` (Go 1.27 installed this session).
- `packages/constants`, `packages/config`, `packages/i18n` (en + ar, parity-checked), `packages/contracts` (CI, collector, event, asset, impact, integration, organization; 18 JSON Schemas; GraphQL 0.1.0; twelve layers; CI short codes; headline metric per layer), `packages/ui` (Obsidian Pro tokens and RTL components, 39 tests), `packages/db` (Prisma 6 schema with 35 models, migrations 0001–0003 applied; ClickHouse DDL; Memgraph schema and triggers; runners), `packages/graph` (Cypher repository, Memgraph default, Neo4j adapter; impact and time-travel verified on live Memgraph), `packages/testing` (compose harness, fixture catalogue).
- `tools/tracker` (187 requirement rows), `tools/guard`, `tools/synth-estate` (deterministic; scale 1 = 550k CIs in 17.5 s).
- `apps/api`: NestJS on Fastify, Mercurius, schema-first; Keycloak JWKS auth; outbox writes; every module in the schema; 26 unit + 12 integration tests; live smoke with a Keycloak token passed.
- `apps/console`: Next.js 15 shell with en/ar routing and RTL, dashboard, layers and CMDB routes over GraphQL (builds; Playwright config present, browsers not installed locally).
- `apps/scheduler`: planner (CIDR expansion, chunking, budget check) and the Node API (mTLS enrolment with CSR signing, heartbeat, atomic job pull, result intake with evidence, OpenBao credential resolution, BullMQ results queue); unit and Postgres integration tests.
- `apps/reconciler`: identity resolution (tuple plus globally unique keys), confidence merge, persistence, pending-relationship retry, outbox dispatcher to Memgraph, ClickHouse, Meilisearch and the event stream; `replay` tool. Replay of the scale-0.05 estate: 68 results → 28,200 current CIs, 0 duplicate identities.
- `apps/bsm-engine`: health propagation, SLA budgets, redundancy-aware impact simulation, ITSM/SIEM/on-call payloads with a retrying delivery engine.
- `apps/assistant`: schema-grounded NL→Cypher with read-only validation and an OpenAI-compatible local LLM client.
- `apps/node` (Go): mTLS transport, pull loop, collector supervisor, enrolment CLI; tests pass.
- `apps/collectors` (Go): shared runtime plus `snmp` (v2c/v3; MIB-II, IF-MIB, ENTITY-MIB, LLDP, Q-BRIDGE, ARP) and `ssh_agentless` (Linux hosts, OS, interfaces, listeners, software; host-key pinning); tests pass.
- `deploy/compose`: full stack up and healthy locally (Postgres, Memgraph, ClickHouse, Valkey, Meilisearch, Keycloak with managed `tenant` attribute, OpenBao, Superset, OTel, Prometheus); air-gap overlay.
- Design: 13 screens on the Obsidian Pro canvas, two interactive (Impact modeling, Onboarding): https://claude.ai/artifact/VcFmJuAaHCmrvgpPMmTzrf. Cues adopted from the AetherTwin review are in `docs/DESIGN-CUES.md`.

**Decisions this session:** ADR-001…005 (tooling; contracts without SPEC; Go not Rust; twelve layers; plans not purchase orders). Pending ADR: `@peculiar/x509` dependency for Node PKI (not in SPEC's component table).

## In progress

- REQ-CORE-001/002/005/006 contracts at 0.1.0: frozen once the console consumes the API end to end.
- REQ-CORE-013 reconciler: pipeline works; throughput on the small estate was about 290 observations per second, which is too slow for the 10k-devices-in-15-minutes budget. Next: batch CI updates and the pending-relationship pass per sweep rather than per result.
- REQ-DISC-001/003 collectors: built and unit-tested; Done needs recorded vendor fixtures.
- REQ-DISC-028/031 Node and scheduler: built; end-to-end enrol → pull → result over real mTLS not yet exercised (needs `pnpm --filter @openmap/scheduler pki:init` and a Node run against the scheduler).
- REQ-UI-003… console: shell and three routes exist; remaining screens from the canvas are not built.
- REQ-INT-005/006/007 integrations: payloads and delivery engine exist; no adapter is wired to a real remote yet.
- REQ-SEC-001/002/004: Keycloak auth, OpenBao reads and Node PKI implemented; not yet exercised in the air-gap profile.

## Blocked

- docs/SPEC.md still missing (risk R-001). Tracker rows are seeded from CLAUDE.md, the capability map and the design canvas.
- Vendor lab fixtures (risk R-004): no recorded SNMP walks or SSH transcripts from real devices yet; collectors cannot reach Done without them.

## Next three

1. REQ-CORE-013 throughput: batch persistence, run pending-relationship retry per sweep, measure the scale-1 estate against the 15-minute budget (`pnpm --filter @openmap/reconciler replay --dir <scale-1 dir>`).
2. End-to-end discovery on the real stack: `scheduler pki:init`, start scheduler, enrol a Node, run the `snmp` collector against a recorded or lab device, see the CI in the console.
3. Console screens from the canvas: dependency map (Sigma.js in a worker, lane layout), CI detail, impact modeling (wired to `runSimulation`), sites and connectivity, health and telemetry.

## Questions for Syed

1. Export the planning document to `docs/SPEC.md` so the tracker can be re-seeded and the contracts frozen against it.
2. Access to the vendor lab (or recorded `snmpwalk` / SSH transcripts) for Cisco, Arista, Dell iDRAC, HPE iLO, VMware, Nutanix: nothing can be fabricated.
3. Confirm the ADR for `@peculiar/x509` (MIT) as the Node PKI library.
4. Confirm multi-tenancy is per business unit as drawn in onboarding.
