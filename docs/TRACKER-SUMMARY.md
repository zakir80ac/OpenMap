# OpenMap tracker summary

Generated 2026-11-05T14:03:16.361Z from `tracker/OpenMap-Tracker.xlsx`. Do not edit; run `pnpm tracker report`.

| Status | Count |
| --- | ---: |
| Not started | 66 |
| In progress | 28 |
| Blocked | 0 |
| In review | 4 |
| Done | 108 |
| **Total** | **206** |

## By workstream

| Workstream | Total | Done | In progress | Blocked | % done |
| --- | ---: | ---: | ---: | ---: | ---: |
| CORE | 19 | 17 | 1 | 0 | 89% |
| DISC | 31 | 2 | 26 | 0 | 6% |
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
- REQ-CMDB-022 · SaaS asset inventory (Microsoft 365, Salesforce, ServiceNow, Workday, Google Workspace): seats, SSO, renewals, data flows

## Blocked


## Next up

- REQ-CORE-013 [P0] Reconciler and outbox fan-out (apps/reconciler)
- REQ-DISC-001 [P0] Agentless discovery: SNMP v1/v2c/v3
- REQ-DISC-002 [P0] WMI / WinRM Windows discovery
- REQ-DISC-003 [P0] SSH Linux/Unix discovery
- REQ-DISC-005 [P0] Hypervisor: VMware vCenter/ESXi
- REQ-DISC-006 [P0] Hypervisor: Hyper-V / SCVMM
- REQ-DISC-007 [P0] Hypervisor: KVM / libvirt, oVirt, Proxmox
- REQ-DISC-008 [P0] Hypervisor: Nutanix AHV (Prism)
- REQ-DISC-009 [P0] Hypervisor: Oracle VM / OLVM
- REQ-DISC-010 [P0] Cloud: AWS, Azure, GCP, OCI, Alibaba

## Open risks

- R-001 (High/Medium) docs/SPEC.md not yet provided; requirements seeded from CLAUDE.md, the capability map and the design canvas
- R-002 (High/High) Go toolchain not installed on the build machine
- R-003 (Medium/Medium) Memgraph community licence (BSL) constraints for commercial redistribution
- R-004 (High/High) Vendor fixtures require access to real devices for every collector family
- R-005 (Medium/High) 100k-node impact query budget of 1 s depends on Memgraph tuning and graph shape
- R-006 (Low/Medium) k6 is AGPL; must run as a separate process, never linked
