# OpenMap tracker summary

Generated 2026-11-07T22:51:40.425Z from `tracker/OpenMap-Tracker.xlsx`. Do not edit; run `pnpm tracker report`.

| Status | Count |
| --- | ---: |
| Not started | 40 |
| In progress | 0 |
| Blocked | 28 |
| In review | 2 |
| Done | 138 |
| **Total** | **208** |

## By workstream

| Workstream | Total | Done | In progress | Blocked | % done |
| --- | ---: | ---: | ---: | ---: | ---: |
| CORE | 20 | 18 | 0 | 0 | 90% |
| DISC | 31 | 5 | 0 | 26 | 16% |
| DEP | 5 | 5 | 0 | 0 | 100% |
| CMDB | 42 | 40 | 0 | 2 | 95% |
| IPAM | 7 | 3 | 0 | 0 | 43% |
| DCIM | 9 | 2 | 0 | 0 | 22% |
| BSM | 8 | 8 | 0 | 0 | 100% |
| UI | 36 | 31 | 0 | 0 | 86% |
| AI | 8 | 4 | 0 | 0 | 50% |
| INT | 19 | 8 | 0 | 0 | 42% |
| QA | 5 | 3 | 0 | 0 | 60% |
| PERF | 5 | 2 | 0 | 0 | 40% |
| SEC | 13 | 9 | 0 | 0 | 69% |

## In progress


## Blocked

- REQ-DISC-001 · Agentless discovery: SNMP v1/v2c/v3 — PARKED 2026-11-07 (Syed): real vendor access, licences, tenants or the code-signing decision come later; meanwhile exercised in simulated mode (tools/simulator, ADR-042). Simulated runs never close this row. Net-SNMP over v1, v2c and v3 captured (v1 path added). Missing: vendor hardware walks (Cisco, Juniper, Arista, HPE/H3C, Fortinet, Palo Alto, Brocade, Dell).
- REQ-DISC-002 · WMI / WinRM Windows discovery — PARKED 2026-11-07 (Syed): real vendor access, licences, tenants or the code-signing decision come later; meanwhile exercised in simulated mode (tools/simulator, ADR-042). Simulated runs never close this row. Code complete (protocol-shaped tests). Needs a recorded WinRM capture from a Windows Server host (licence/evaluation VM) to close; capturing Syed's own Windows 11 PC was not done (it would put personal inventory in the repo).
- REQ-DISC-003 · SSH Linux/Unix discovery — PARKED 2026-11-07 (Syed): real vendor access, licences, tenants or the code-signing decision come later; meanwhile exercised in simulated mode (tools/simulator, ADR-042). Simulated runs never close this row. Recorded fixtures from Ubuntu 24.04, Debian 12, AlmaLinux 9.8, Alpine 3.20 and Amazon Linux 2023 parse (T-300, recaptured with the parts and utilisation sections). Missing: AIX, Solaris, HP-UX (proprietary OS/hardware; the script is Linux-only). Done once Syed confirms the Linux scope or provides Unix hosts.
- REQ-DISC-004 · Device42 agent (Windows, Linux, macOS) — PARKED 2026-11-07 (Syed): real vendor access, licences, tenants or the code-signing decision come later; meanwhile exercised in simulated mode (tools/simulator, ADR-042). Simulated runs never close this row. Host agent (Linux/Windows/macOS) with mTLS enrolment via the Node gateway, standing agent job per agent, service installers (systemd, launchd, Windows service), env file OPENMAP_AGENT_ENV_FILE; verified live enrol+report in compose
- REQ-DISC-005 · Hypervisor: VMware vCenter/ESXi — PARKED 2026-11-07 (Syed): real vendor access, licences, tenants or the code-signing decision come later; meanwhile exercised in simulated mode (tools/simulator, ADR-042). Simulated runs never close this row. Code complete. Needs a recorded vCenter/ESXi capture (licensed lab or VMware evaluation).
- REQ-DISC-006 · Hypervisor: Hyper-V / SCVMM — PARKED 2026-11-07 (Syed): real vendor access, licences, tenants or the code-signing decision come later; meanwhile exercised in simulated mode (tools/simulator, ADR-042). Simulated runs never close this row. Code complete. Needs a recorded Hyper-V / SCVMM capture (Windows Server with Hyper-V).
- REQ-DISC-007 · Hypervisor: KVM / libvirt, oVirt, Proxmox — PARKED 2026-11-07 (Syed): real vendor access, licences, tenants or the code-signing decision come later; meanwhile exercised in simulated mode (tools/simulator, ADR-042). Simulated runs never close this row. libvirt/QEMU captured (T-315). Missing: oVirt/OLVM engine; Proxmox VE needs its own collector (qm/API, not libvirt).
- REQ-DISC-008 · Hypervisor: Nutanix AHV (Prism) — PARKED 2026-11-07 (Syed): real vendor access, licences, tenants or the code-signing decision come later; meanwhile exercised in simulated mode (tools/simulator, ADR-042). Simulated runs never close this row. Code complete. Needs a recorded Nutanix Prism capture (CE cluster or vendor lab).
- REQ-DISC-009 · Hypervisor: Oracle VM / OLVM — PARKED 2026-11-07 (Syed): real vendor access, licences, tenants or the code-signing decision come later; meanwhile exercised in simulated mode (tools/simulator, ADR-042). Simulated runs never close this row. Code complete. Needs a recorded Oracle VM / OLVM capture.
- REQ-DISC-010 · Cloud: AWS, Azure, GCP, OCI, Alibaba — PARKED 2026-11-07 (Syed): real vendor access, licences, tenants or the code-signing decision come later; meanwhile exercised in simulated mode (tools/simulator, ADR-042). Simulated runs never close this row. Code complete. Needs read-only AWS, Azure, GCP, OCI and Alibaba accounts to record API responses.
- REQ-DISC-011 · Kubernetes / OpenShift / Docker — PARKED 2026-11-07 (Syed): real vendor access, licences, tenants or the code-signing decision come later; meanwhile exercised in simulated mode (tools/simulator, ADR-042). Simulated runs never close this row. kind and K3s captured; new Docker Engine collector captured read-only from Docker Desktop and docker:dind. Missing: OpenShift, EKS, AKS, GKE; Docker engines with TLS client certificates.
- REQ-DISC-012 · IPMI / Redfish out-of-band (iLO, iDRAC, XClarity, CIMC, generic BMC) — PARKED 2026-11-07 (Syed): real vendor access, licences, tenants or the code-signing decision come later; meanwhile exercised in simulated mode (tools/simulator, ADR-042). Simulated runs never close this row. Code complete (Redfish now also walks processors, memory, drives, adapters, PSUs and samples power). Needs recorded Redfish/IPMI captures from iLO, iDRAC, XClarity, CIMC (DMTF mockups are not recordings of this collector).
- REQ-DISC-013 · Blade chassis / Cisco UCS / HPE OneView — PARKED 2026-11-07 (Syed): real vendor access, licences, tenants or the code-signing decision come later; meanwhile exercised in simulated mode (tools/simulator, ADR-042). Simulated runs never close this row. Code complete. Needs recorded Cisco UCS Manager and HPE OneView captures.
- REQ-DISC-014 · Storage arrays: Pure, NetApp, Dell EMC, HPE, IBM, Hitachi — PARKED 2026-11-07 (Syed): real vendor access, licences, tenants or the code-signing decision come later; meanwhile exercised in simulated mode (tools/simulator, ADR-042). Simulated runs never close this row. Code complete. Needs recorded Pure, NetApp, Dell EMC, HPE, IBM and Hitachi array captures.
- REQ-DISC-015 · Fibre Channel fabric: Brocade, Cisco MDS (zones, name server) — PARKED 2026-11-07 (Syed): real vendor access, licences, tenants or the code-signing decision come later; meanwhile exercised in simulated mode (tools/simulator, ADR-042). Simulated runs never close this row. Code complete. Needs recorded Brocade and Cisco MDS fabric captures.
- REQ-DISC-016 · NAS shares: SMB, NFS — PARKED 2026-11-07 (Syed): real vendor access, licences, tenants or the code-signing decision come later; meanwhile exercised in simulated mode (tools/simulator, ADR-042). Simulated runs never close this row. Samba, knfsd, rpc.mountd and NFS-Ganesha captured (T-303). Missing: Windows SMB (licence), NetApp ONTAP / PowerScale (appliances).
- REQ-DISC-017 · Object storage: S3, MinIO, Ceph RGW — PARKED 2026-11-07 (Syed): real vendor access, licences, tenants or the code-signing decision come later; meanwhile exercised in simulated mode (tools/simulator, ADR-042). Simulated runs never close this row. MinIO and Ceph RGW captured (T-304). Missing: AWS S3 (account), Dell ECS, StorageGRID. Open: RGW public-access flag and MinIO anonymous policy need the bucket policy status read.
- REQ-DISC-018 · Load balancers: F5, Citrix ADC, A10, HAProxy, NGINX — PARKED 2026-11-07 (Syed): real vendor access, licences, tenants or the code-signing decision come later; meanwhile exercised in simulated mode (tools/simulator, ADR-042). Simulated runs never close this row. HAProxy 3.2/2.8 and NGINX OSS stub_status captured (T-305, T-306). Missing: NGINX Plus API, F5 BIG-IP, Citrix ADC, A10 (commercial).
- REQ-DISC-019 · Network flow: NetFlow v5/v9, IPFIX, sFlow — PARKED 2026-11-07 (Syed): real vendor access, licences, tenants or the code-signing decision come later; meanwhile exercised in simulated mode (tools/simulator, ADR-042). Simulated runs never close this row. NetFlow v5/v9, IPFIX and sFlow over IPv4 and IPv6 from softflowd and pmacct captured. Missing: hardware router/switch exporters.
- REQ-DISC-020 · Port scan / service fingerprint (nmap-class) — PARKED 2026-11-07 (Syed): real vendor access, licences, tenants or the code-signing decision come later; meanwhile exercised in simulated mode (tools/simulator, ADR-042). Simulated runs never close this row. Linux services, xrdp, SQL Server, Oracle, etcd/kube-apiserver/kubelet, Exim, ProFTPD, Pure-FTPd, Samba, MongoDB, OpenLDAP, BIND, Docker, RabbitMQ, OpenSearch captured. Missing: WinRM, MS RPC, Exchange, FileZilla (Windows); VMware, Proxmox, Nutanix ports.
- REQ-DISC-021 · DNS zone discovery and sync (BIND, Windows DNS, Infoblox, Route 53) — PARKED 2026-11-07 (Syed): real vendor access, licences, tenants or the code-signing decision come later; meanwhile exercised in simulated mode (tools/simulator, ADR-042). Simulated runs never close this row. BIND, Knot and PowerDNS AXFR captured (T-309). Missing: Windows DNS (licence), Infoblox (appliance), Route 53 (account).
- REQ-DISC-022 · DHCP scope/lease discovery (ISC, Kea, Windows DHCP) — PARKED 2026-11-07 (Syed): real vendor access, licences, tenants or the code-signing decision come later; meanwhile exercised in simulated mode (tools/simulator, ADR-042). Simulated runs never close this row. ISC dhcpd and Kea with real leases captured (T-310). Missing: Windows DHCP (licence).
- REQ-DISC-023 · Active Directory / LDAP users, groups, service accounts — PARKED 2026-11-07 (Syed): real vendor access, licences, tenants or the code-signing decision come later; meanwhile exercised in simulated mode (tools/simulator, ADR-042). Simulated runs never close this row. OpenLDAP and Samba AD DC captured (T-311). Missing: Microsoft Active Directory on a Windows DC.
- REQ-DISC-026 · PDU / UPS / CRAC monitoring over SNMP — PARKED 2026-11-07 (Syed): real vendor access, licences, tenants or the code-signing decision come later; meanwhile exercised in simulated mode (tools/simulator, ADR-042). Simulated runs never close this row. Code complete. Needs SNMP walks from real PDUs, UPS and CRAC units (APC, Raritan, Vertiv/Liebert); Net-SNMP implements none of their MIBs.
- REQ-DISC-027 · Vulnerability feed ingestion (NVD, vendor advisories, Tenable/Qualys/Rapid7 imports) — PARKED 2026-11-07 (Syed): real vendor access, licences, tenants or the code-signing decision come later; meanwhile exercised in simulated mode (tools/simulator, ADR-042). Simulated runs never close this row. Three real NVD CVE API 2.0 responses parse (NVD score preferred, CISA KEV fields). Missing: Tenable, Qualys and Rapid7 import parsers need real exports from those products.
- REQ-CMDB-022 · SaaS asset inventory (Microsoft 365, Salesforce, ServiceNow, Workday, Google Workspace): seats, SSO, renewals, data flows — PARKED 2026-11-07 (Syed): real vendor access, licences, tenants or the code-signing decision come later; meanwhile exercised in simulated mode (tools/simulator, ADR-042). Simulated runs never close this row. SaaS collector (Graph, Google Admin SDK, Salesforce, ServiceNow, Workday; T-075) plus the SaaS inventory read model and screen (ADR-041, d435514, T-213..T-215). Done needs recorded API responses from real tenants (R-004): Microsoft 365 developer tenant, Salesforce Developer Edition, ServiceNow PDI, Google Workspace and Workday sandboxes.
- REQ-CMDB-024 · Warranty tracking with vendor API lookups (Dell, HPE, Lenovo, Cisco, IBM) — PARKED 2026-11-07 (Syed): real vendor access, licences, tenants or the code-signing decision come later; meanwhile exercised in simulated mode (tools/simulator, ADR-042). Simulated runs never close this row. Vendor warranty and EoX lookups (Dell TechDirect, HPE, Lenovo, Cisco SN2INFO/EoX, IBM) need tenant API credentials and recorded responses before adapters can be written and tested without inventing response shapes (R-004). Integration vendors already registered (dell_techdirect, hpe_warranty, lenovo_warranty, cisco_sntc, ibm_support); lifecycle catalogue and asset endOfLife already consume their dates (ADR-039).
- REQ-DISC-031 · Remote Collector install — PARKED 2026-11-07 (Syed): real vendor access, licences, tenants or the code-signing decision come later; meanwhile exercised in simulated mode (tools/simulator, ADR-042). Simulated runs never close this row. Bare-metal installers: systemd unit + install-node.sh, Windows service hosting + install-node.ps1, env file OPENMAP_NODE_ENV_FILE; node certs carry DNS SAN + serverAuth for the agent gateway

## Next up

- REQ-CORE-019 [P0] REST and GraphQL API, SDKs, OpenAPI
- REQ-PERF-002 [P0] Impact query under 1000 ms on 100000 nodes
- REQ-PERF-004 [P0] 10000 devices discovered in under 15 minutes
- REQ-QA-003 [P0] Vendor lab fixtures for every collector family
- REQ-UI-026 [P0] Screen · Sites and connectivity: WAN links with carrier telemetry, telco transit health, site facility cards
- REQ-UI-027 [P0] Screen · Health and telemetry fleet table: CI, category and site, IP/FQDN, health, CPU, memory, IOPS, throughput, Apdex
- REQ-AI-002 [P1] Classification of unknown CIs and layer suggestions
- REQ-AI-003 [P1] Anomaly rules over discovery and health events
- REQ-AI-005 [P1] Cloud recommendation engine (rightsizing, unused)
- REQ-AI-006 [P1] AI assistant over the graph (NL to Cypher, explain impact, anomaly rules)

## Open risks

- R-001 (High/Medium) docs/SPEC.md not yet provided; requirements seeded from CLAUDE.md, the capability map and the design canvas
- R-002 (High/High) Go toolchain not installed on the build machine
- R-003 (Medium/Medium) Memgraph community licence (BSL) constraints for commercial redistribution
- R-004 (High/High) Vendor fixtures require access to real devices for every collector family
- R-005 (Medium/High) 100k-node impact query budget of 1 s depends on Memgraph tuning and graph shape
- R-006 (Low/Medium) k6 is AGPL; must run as a separate process, never linked
