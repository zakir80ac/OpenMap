# OpenMap tracker summary

Generated 2026-10-22T07:01:31.574Z from `tracker/OpenMap-Tracker.xlsx`. Do not edit; run `pnpm tracker report`.

| Status | Count |
| --- | ---: |
| Not started | 151 |
| In progress | 25 |
| Blocked | 0 |
| In review | 0 |
| Done | 11 |
| **Total** | **187** |

## By workstream

| Workstream | Total | Done | In progress | Blocked | % done |
| --- | ---: | ---: | ---: | ---: | ---: |
| CORE | 19 | 8 | 5 | 0 | 42% |
| DISC | 31 | 0 | 5 | 0 | 0% |
| DEP | 5 | 0 | 0 | 0 | 0% |
| CMDB | 38 | 0 | 1 | 0 | 0% |
| IPAM | 7 | 0 | 2 | 0 | 0% |
| DCIM | 9 | 0 | 1 | 0 | 0% |
| BSM | 5 | 0 | 2 | 0 | 0% |
| UI | 27 | 2 | 0 | 0 | 7% |
| AI | 6 | 0 | 1 | 0 | 0% |
| INT | 19 | 0 | 5 | 0 | 0% |
| QA | 4 | 1 | 0 | 0 | 25% |
| PERF | 5 | 0 | 0 | 0 | 0% |
| SEC | 12 | 0 | 3 | 0 | 0% |

## In progress

- REQ-CORE-001 · CI contract frozen (packages/contracts/ci.ts)
- REQ-CORE-002 · Collector contract frozen (collector.ts)
- REQ-CORE-005 · Event contract frozen (event.ts)
- REQ-CORE-006 · GraphQL schema frozen (graphql/schema.graphql)
- REQ-CORE-013 · Reconciler and outbox fan-out (apps/reconciler)
- REQ-SEC-001 · Keycloak OIDC with roles and attribute-based access
- REQ-SEC-002 · OpenBao for collector and integration credentials
- REQ-SEC-004 · mTLS between Discovery Nodes and the scheduler
- REQ-INT-001 · Single-node docker compose profile
- REQ-INT-002 · Air-gapped compose profile and offline bundle
- REQ-AI-001 · NL to Cypher with schema grounding and read-only execution
- REQ-DISC-001 · Agentless discovery: SNMP v1/v2c/v3
- REQ-DISC-003 · SSH Linux/Unix discovery
- REQ-DISC-028 · Remote Collector (RC) per site, pull model, no inbound ports
- REQ-DISC-029 · Discovery scheduling, exclusions, rate limits, credential sets
- REQ-IPAM-001 · Subnets, supernets, VRFs, VLANs, utilisation
- REQ-IPAM-002 · IP addresses, reservations, DHCP ranges, conflicts
- REQ-DCIM-002 · Buildings, rooms, rows, racks, rack layouts (front/rear)
- REQ-BSM-002 · Service health, SLA/SLO, incident correlation, cost allocation
- REQ-BSM-003 · Change impact (planned maintenance "what if")
- REQ-INT-005 · Incident reporting to ITSM
- REQ-INT-006 · SIEM and SOAR integration
- REQ-INT-007 · Delivery audit and replay for every integration message
- REQ-DISC-031 · Remote Collector install
- REQ-CMDB-037 · CI short codes (layer prefix plus slug) generated, unique per tenant and editable

## Blocked


## Next up

- REQ-CORE-001 [P0] CI contract frozen (packages/contracts/ci.ts)
- REQ-CORE-002 [P0] Collector contract frozen (collector.ts)
- REQ-CORE-005 [P0] Event contract frozen (event.ts)
- REQ-CORE-006 [P0] GraphQL schema frozen (graphql/schema.graphql)
- REQ-CORE-013 [P0] Reconciler and outbox fan-out (apps/reconciler)
- REQ-SEC-001 [P0] Keycloak OIDC with roles and attribute-based access
- REQ-SEC-002 [P0] OpenBao for collector and integration credentials
- REQ-SEC-004 [P0] mTLS between Discovery Nodes and the scheduler
- REQ-INT-001 [P0] Single-node docker compose profile
- REQ-INT-002 [P0] Air-gapped compose profile and offline bundle

## Open risks

- R-001 (High/Medium) docs/SPEC.md not yet provided; requirements seeded from CLAUDE.md, the capability map and the design canvas
- R-002 (High/High) Go toolchain not installed on the build machine
- R-003 (Medium/Medium) Memgraph community licence (BSL) constraints for commercial redistribution
- R-004 (High/High) Vendor fixtures require access to real devices for every collector family
- R-005 (Medium/High) 100k-node impact query budget of 1 s depends on Memgraph tuning and graph shape
- R-006 (Low/Medium) k6 is AGPL; must run as a separate process, never linked
