# OpenMap tracker summary

Generated 2026-11-05T14:46:21.243Z from `tracker/OpenMap-Tracker.xlsx`. Do not edit; run `pnpm tracker report`.

| Status | Count |
| --- | ---: |
| Not started | 65 |
| In progress | 2 |
| Blocked | 0 |
| In review | 30 |
| Done | 109 |
| **Total** | **206** |

## By workstream

| Workstream | Total | Done | In progress | Blocked | % done |
| --- | ---: | ---: | ---: | ---: | ---: |
| CORE | 19 | 17 | 1 | 0 | 89% |
| DISC | 31 | 3 | 0 | 0 | 10% |
| DEP | 5 | 2 | 0 | 0 | 40% |
| CMDB | 42 | 21 | 1 | 0 | 50% |
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
- REQ-DEP-001 [P0] Network topology maps (L2/L3, LLDP/CDP)
- REQ-DEP-002 [P0] Application Dependency Mapping from flows, processes, listeners
- REQ-DEP-004 [P0] Enterprise application dependency (multi-tier, cloud and on-prem)
- REQ-PERF-002 [P0] Impact query under 1000 ms on 100000 nodes

## Open risks

- R-001 (High/Medium) docs/SPEC.md not yet provided; requirements seeded from CLAUDE.md, the capability map and the design canvas
- R-002 (High/High) Go toolchain not installed on the build machine
- R-003 (Medium/Medium) Memgraph community licence (BSL) constraints for commercial redistribution
- R-004 (High/High) Vendor fixtures require access to real devices for every collector family
- R-005 (Medium/High) 100k-node impact query budget of 1 s depends on Memgraph tuning and graph shape
- R-006 (Low/Medium) k6 is AGPL; must run as a separate process, never linked
