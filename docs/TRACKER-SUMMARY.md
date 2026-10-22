# OpenMap tracker summary

Generated 2026-10-22T05:48:19.064Z from `tracker/OpenMap-Tracker.xlsx`. Do not edit; run `pnpm tracker report`.

| Status | Count |
| --- | ---: |
| Not started | 168 |
| In progress | 7 |
| Blocked | 0 |
| In review | 0 |
| Done | 5 |
| **Total** | **180** |

## By workstream

| Workstream | Total | Done | In progress | Blocked | % done |
| --- | ---: | ---: | ---: | ---: | ---: |
| CORE | 19 | 4 | 4 | 0 | 21% |
| DISC | 31 | 0 | 0 | 0 | 0% |
| DEP | 4 | 0 | 0 | 0 | 0% |
| CMDB | 36 | 0 | 0 | 0 | 0% |
| IPAM | 7 | 0 | 0 | 0 | 0% |
| DCIM | 9 | 0 | 0 | 0 | 0% |
| BSM | 4 | 0 | 0 | 0 | 0% |
| UI | 25 | 1 | 1 | 0 | 4% |
| AI | 6 | 0 | 0 | 0 | 0% |
| INT | 19 | 0 | 2 | 0 | 0% |
| QA | 4 | 0 | 0 | 0 | 0% |
| PERF | 5 | 0 | 0 | 0 | 0% |
| SEC | 11 | 0 | 0 | 0 | 0% |

## In progress

- REQ-CORE-001 · CI contract frozen (packages/contracts/ci.ts)
- REQ-CORE-002 · Collector contract frozen (collector.ts)
- REQ-CORE-005 · Event contract frozen (event.ts)
- REQ-CORE-006 · GraphQL schema frozen (graphql/schema.graphql)
- REQ-UI-001 · Obsidian Pro design tokens and components (packages/ui)
- REQ-INT-001 · Single-node docker compose profile
- REQ-INT-002 · Air-gapped compose profile and offline bundle

## Blocked


## Next up

- REQ-CORE-001 [P0] CI contract frozen (packages/contracts/ci.ts)
- REQ-CORE-002 [P0] Collector contract frozen (collector.ts)
- REQ-CORE-005 [P0] Event contract frozen (event.ts)
- REQ-CORE-006 [P0] GraphQL schema frozen (graphql/schema.graphql)
- REQ-UI-001 [P0] Obsidian Pro design tokens and components (packages/ui)
- REQ-INT-001 [P0] Single-node docker compose profile
- REQ-INT-002 [P0] Air-gapped compose profile and offline bundle
- REQ-AI-001 [P0] NL to Cypher with schema grounding and read-only execution
- REQ-BSM-001 [P0] Business applications / affinity groups
- REQ-BSM-002 [P0] Service health, SLA/SLO, incident correlation, cost allocation

## Open risks

- R-001 (High/Medium) docs/SPEC.md not yet provided; requirements seeded from CLAUDE.md, the capability map and the design canvas
- R-002 (High/High) Go toolchain not installed on the build machine
- R-003 (Medium/Medium) Memgraph community licence (BSL) constraints for commercial redistribution
- R-004 (High/High) Vendor fixtures require access to real devices for every collector family
- R-005 (Medium/High) 100k-node impact query budget of 1 s depends on Memgraph tuning and graph shape
- R-006 (Low/Medium) k6 is AGPL; must run as a separate process, never linked
