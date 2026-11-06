# OpenMap tracker summary

Generated 2026-11-06T18:21:20.751Z from `tracker/OpenMap-Tracker.xlsx`. Do not edit; run `pnpm tracker report`.

| Status | Count |
| --- | ---: |
| Not started | 53 |
| In progress | 2 |
| Blocked | 0 |
| In review | 30 |
| Done | 121 |
| **Total** | **206** |

## By workstream

| Workstream | Total | Done | In progress | Blocked | % done |
| --- | ---: | ---: | ---: | ---: | ---: |
| CORE | 19 | 17 | 1 | 0 | 89% |
| DISC | 31 | 3 | 0 | 0 | 10% |
| DEP | 5 | 5 | 0 | 0 | 100% |
| CMDB | 42 | 30 | 1 | 0 | 71% |
| IPAM | 7 | 3 | 0 | 0 | 43% |
| DCIM | 9 | 2 | 0 | 0 | 22% |
| BSM | 8 | 5 | 0 | 0 | 63% |
| UI | 36 | 31 | 0 | 0 | 86% |
| AI | 8 | 4 | 0 | 0 | 50% |
| INT | 19 | 8 | 0 | 0 | 42% |
| QA | 4 | 2 | 0 | 0 | 50% |
| PERF | 5 | 2 | 0 | 0 | 40% |
| SEC | 13 | 9 | 0 | 0 | 69% |

## In progress

- REQ-CORE-013 · Reconciler and outbox fan-out (apps/reconciler)
- REQ-CMDB-022 · SaaS asset inventory (Microsoft 365, Salesforce, ServiceNow, Workday, Google Workspace): seats, SSO, renewals, data flows

## Blocked


## Next up

- REQ-CORE-013 [P0] Reconciler and outbox fan-out (apps/reconciler)
- REQ-CMDB-022 [P1] SaaS asset inventory (Microsoft 365, Salesforce, ServiceNow, Workday, Google Workspace): seats, SSO, renewals, data flows
- REQ-BSM-004 [P0] Impact prediction accuracy
- REQ-BSM-005 [P0] Runbooks attached to scenarios and incidents with automation hooks per step
- REQ-BSM-007 [P0] Sites and connectivity monitoring for HA / DR readiness
- REQ-CORE-019 [P0] REST and GraphQL API, SDKs, OpenAPI
- REQ-PERF-002 [P0] Impact query under 1000 ms on 100000 nodes
- REQ-PERF-004 [P0] 10000 devices discovered in under 15 minutes
- REQ-QA-003 [P0] Vendor lab fixtures for every collector family
- REQ-UI-026 [P0] Screen · Sites and connectivity: WAN links with carrier telemetry, telco transit health, site facility cards

## Open risks

- R-001 (High/Medium) docs/SPEC.md not yet provided; requirements seeded from CLAUDE.md, the capability map and the design canvas
- R-002 (High/High) Go toolchain not installed on the build machine
- R-003 (Medium/Medium) Memgraph community licence (BSL) constraints for commercial redistribution
- R-004 (High/High) Vendor fixtures require access to real devices for every collector family
- R-005 (Medium/High) 100k-node impact query budget of 1 s depends on Memgraph tuning and graph shape
- R-006 (Low/Medium) k6 is AGPL; must run as a separate process, never linked
