# OpenMap tracker summary

Generated 2026-10-22T19:27:00.405Z from `tracker/OpenMap-Tracker.xlsx`. Do not edit; run `pnpm tracker report`.

| Status | Count |
| --- | ---: |
| Not started | 96 |
| In progress | 45 |
| Blocked | 0 |
| In review | 9 |
| Done | 38 |
| **Total** | **188** |

## By workstream

| Workstream | Total | Done | In progress | Blocked | % done |
| --- | ---: | ---: | ---: | ---: | ---: |
| CORE | 19 | 12 | 1 | 0 | 63% |
| DISC | 31 | 1 | 27 | 0 | 3% |
| DEP | 5 | 0 | 2 | 0 | 0% |
| CMDB | 38 | 0 | 3 | 0 | 0% |
| IPAM | 7 | 0 | 2 | 0 | 0% |
| DCIM | 9 | 0 | 1 | 0 | 0% |
| BSM | 5 | 0 | 3 | 0 | 0% |
| UI | 27 | 18 | 0 | 0 | 67% |
| AI | 6 | 0 | 2 | 0 | 0% |
| INT | 19 | 2 | 3 | 0 | 11% |
| QA | 4 | 1 | 0 | 0 | 25% |
| PERF | 5 | 0 | 0 | 0 | 0% |
| SEC | 13 | 4 | 1 | 0 | 31% |

## In progress

- REQ-CORE-013 · Reconciler and outbox fan-out (apps/reconciler)
- REQ-SEC-002 · OpenBao for collector and integration credentials
- REQ-AI-001 · NL to Cypher with schema grounding and read-only execution
- REQ-AI-004 · Recommended actions in impact modeling and incidents
- REQ-CMDB-012 · Layer · unknown populated and filterable
- REQ-DISC-001 · Agentless discovery: SNMP v1/v2c/v3
- REQ-DISC-002 · WMI / WinRM Windows discovery
- REQ-DISC-003 · SSH Linux/Unix discovery
- REQ-DISC-005 · Hypervisor: VMware vCenter/ESXi
- REQ-DISC-006 · Hypervisor: Hyper-V / SCVMM
- REQ-DISC-007 · Hypervisor: KVM / libvirt, oVirt, Proxmox
- REQ-DISC-008 · Hypervisor: Nutanix AHV (Prism)
- REQ-DISC-009 · Hypervisor: Oracle VM / OLVM
- REQ-DISC-010 · Cloud: AWS, Azure, GCP, OCI, Alibaba
- REQ-DISC-011 · Kubernetes / OpenShift / Docker
- REQ-DISC-012 · IPMI / Redfish out-of-band (iLO, iDRAC, XClarity, CIMC, generic BMC)
- REQ-DISC-013 · Blade chassis / Cisco UCS / HPE OneView
- REQ-DISC-014 · Storage arrays: Pure, NetApp, Dell EMC, HPE, IBM, Hitachi
- REQ-DISC-015 · Fibre Channel fabric: Brocade, Cisco MDS (zones, name server)
- REQ-DISC-016 · NAS shares: SMB, NFS
- REQ-DISC-017 · Object storage: S3, MinIO, Ceph RGW
- REQ-DISC-018 · Load balancers: F5, Citrix ADC, A10, HAProxy, NGINX
- REQ-DISC-019 · Network flow: NetFlow v5/v9, IPFIX, sFlow
- REQ-DISC-020 · Port scan / service fingerprint (nmap-class)
- REQ-DISC-021 · DNS zone discovery and sync (BIND, Windows DNS, Infoblox, Route 53)
- REQ-DISC-022 · DHCP scope/lease discovery (ISC, Kea, Windows DHCP)
- REQ-DISC-023 · Active Directory / LDAP users, groups, service accounts
- REQ-DISC-024 · Database discovery: PostgreSQL, Oracle, SQL Server, MySQL, MongoDB, Redis
- REQ-DISC-025 · TLS certificate discovery and expiry
- REQ-DISC-026 · PDU / UPS / CRAC monitoring over SNMP
- REQ-DISC-027 · Vulnerability feed ingestion (NVD, vendor advisories, Tenable/Qualys/Rapid7 imports)
- REQ-DISC-029 · Discovery scheduling, exclusions, rate limits, credential sets
- REQ-CMDB-022 · SaaS asset inventory (Microsoft 365, Salesforce, ServiceNow, Workday, Google Workspace): seats, SSO, renewals, data flows
- REQ-IPAM-001 · Subnets, supernets, VRFs, VLANs, utilisation
- REQ-IPAM-002 · IP addresses, reservations, DHCP ranges, conflicts
- REQ-DCIM-002 · Buildings, rooms, rows, racks, rack layouts (front/rear)
- REQ-DEP-003 · Service dependency and impact charts
- REQ-BSM-001 · Business applications / affinity groups
- REQ-BSM-002 · Service health, SLA/SLO, incident correlation, cost allocation
- REQ-BSM-003 · Change impact (planned maintenance "what if")
- REQ-INT-005 · Incident reporting to ITSM
- REQ-INT-006 · SIEM and SOAR integration
- REQ-INT-007 · Delivery audit and replay for every integration message
- REQ-DEP-005 · Lane layout mode: layers as horizontal lanes with blast-radius isolation on click
- REQ-CMDB-037 · CI short codes (layer prefix plus slug) generated, unique per tenant and editable

## Blocked


## Next up

- REQ-CORE-013 [P0] Reconciler and outbox fan-out (apps/reconciler)
- REQ-SEC-002 [P0] OpenBao for collector and integration credentials
- REQ-AI-001 [P0] NL to Cypher with schema grounding and read-only execution
- REQ-AI-004 [P1] Recommended actions in impact modeling and incidents
- REQ-CMDB-012 [P0] Layer · unknown populated and filterable
- REQ-DISC-001 [P0] Agentless discovery: SNMP v1/v2c/v3
- REQ-DISC-002 [P0] WMI / WinRM Windows discovery
- REQ-DISC-003 [P0] SSH Linux/Unix discovery
- REQ-DISC-005 [P0] Hypervisor: VMware vCenter/ESXi
- REQ-DISC-006 [P0] Hypervisor: Hyper-V / SCVMM

## Open risks

- R-001 (High/Medium) docs/SPEC.md not yet provided; requirements seeded from CLAUDE.md, the capability map and the design canvas
- R-002 (High/High) Go toolchain not installed on the build machine
- R-003 (Medium/Medium) Memgraph community licence (BSL) constraints for commercial redistribution
- R-004 (High/High) Vendor fixtures require access to real devices for every collector family
- R-005 (Medium/High) 100k-node impact query budget of 1 s depends on Memgraph tuning and graph shape
- R-006 (Low/Medium) k6 is AGPL; must run as a separate process, never linked
