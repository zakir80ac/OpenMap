# OpenMap capability map — Device42 parity and beyond

Every row here becomes one or more tracker requirements (`pnpm tracker init` reads this file alongside `docs/SPEC.md`). The right-hand columns name the OpenMap module and workstream that own the capability. Nothing is deferred: every row ships in the single release.

Legend for **Parity**: `=` same capability, `+` OpenMap goes further, `~` same outcome via a different mechanism.

## 1. Discovery

| Device42 feature | OpenMap | Parity | WS |
| --- | --- | --- | --- |
| Agentless discovery: SNMP v1/v2c/v3 | `collectors/snmp` | = | DISC |
| WMI / WinRM Windows discovery | `collectors/wmi`, `collectors/winrm` | = | DISC |
| SSH Linux/Unix discovery | `collectors/ssh_agentless`, `collectors/ssh_cli` for network CLI | = | DISC |
| Device42 agent (Windows, Linux, macOS) | `collectors/agent` Go static binary, mTLS to node | = | DISC |
| Hypervisor: VMware vCenter/ESXi | `collectors/vmware` | = | DISC |
| Hypervisor: Hyper-V / SCVMM | `collectors/hyperv` | = | DISC |
| Hypervisor: KVM / libvirt, oVirt, Proxmox | `collectors/kvm_libvirt` | + | DISC |
| Hypervisor: Nutanix AHV (Prism) | `collectors/nutanix_ahv` | = | DISC |
| Hypervisor: Oracle VM / OLVM | `collectors/oracle_vm` | = | DISC |
| Cloud: AWS, Azure, GCP, OCI, Alibaba | `collectors/cloud_aws`, `cloud_azure`, `cloud_gcp` (OCI and Alibaba in tracker as INT rows) | = | DISC |
| Kubernetes / OpenShift / Docker | `collectors/kubernetes` | = | DISC |
| IPMI / Redfish out-of-band (iLO, iDRAC, XClarity, CIMC, generic BMC) | `collectors/ipmi_redfish` | + | DISC |
| Blade chassis / Cisco UCS / HPE OneView | `collectors/ipmi_redfish` chassis mode + UCS manager API | = | DISC |
| Storage arrays: Pure, NetApp, Dell EMC, HPE, IBM, Hitachi | `collectors/storage` | = | DISC |
| Fibre Channel fabric: Brocade, Cisco MDS (zones, name server) | `collectors/fc_fabric` | + | DISC |
| NAS shares: SMB, NFS | `collectors/nas` | + | DISC |
| Object storage: S3, MinIO, Ceph RGW | `collectors/object_storage` | + | DISC |
| Load balancers: F5, Citrix ADC, A10, HAProxy, NGINX | `collectors/load_balancer` | = | DISC |
| Network flow: NetFlow v5/v9, IPFIX, sFlow | `collectors/netflow` | = | DISC |
| Port scan / service fingerprint (nmap-class) | `collectors/port_scan` | = | DISC |
| DNS zone discovery and sync (BIND, Windows DNS, Infoblox, Route 53) | `collectors/dns` | = | DISC |
| DHCP scope/lease discovery (ISC, Kea, Windows DHCP) | `collectors/dhcp` | = | DISC |
| Active Directory / LDAP users, groups, service accounts | `collectors/ldap` | = | DISC |
| Database discovery: PostgreSQL, Oracle, SQL Server, MySQL, MongoDB, Redis | `collectors/database` | = | DISC |
| TLS certificate discovery and expiry | `collectors/certificate` | = | DISC |
| PDU / UPS / CRAC monitoring over SNMP | `collectors/pdu` | = | DISC |
| Vulnerability feed ingestion (NVD, vendor advisories, Tenable/Qualys/Rapid7 imports) | `collectors/vulnerability_feed` | = | DISC |
| Remote Collector (RC) per site, pull model, no inbound ports | `apps/node` Discovery Node, mTLS, job pull | = | DISC |
| Discovery scheduling, exclusions, rate limits, credential sets | `apps/scheduler`, OpenBao credential refs | = | DISC |
| Autodiscovery of unknown devices with sysDescr/banner | `unknown` CI type, label-and-promote flow | + | DISC |
| Discovery scoring and confidence per source | provenance.confidence on every observation | + | CORE |

## 2. CMDB and asset management

| Device42 feature | OpenMap | Parity | WS |
| --- | --- | --- | --- |
| Devices (physical, virtual, blade, cluster, other) with lifecycle | CI types per `packages/contracts/ci.ts`, lifecycle discovered/managed/planned/retired | = | CMDB |
| Device parts/components (CPU, memory, disks, NICs, HBAs) | Parts from SSH, WMI and Redfish on `ObservedCi.components`, kept per kind and slot in `ci_components` with removal, replacement and move tracking by serial; `openmap.component.changed`; Parts tab and Parts register (ADR-037) | = | CMDB |
| Custom fields on every object | `attributes` typed JSON; tenant-defined schema with validation and search | = | CMDB |
| Object categories, tags, labels | `tags`, `layer`, user labels | + | CMDB |
| Asset management: tag, purchase, cost, depreciation | `assetRecordSchema` | = | CMDB |
| Asset lifecycle: planned → in stock → deployed → spare → RMA → retired → disposed, audited | `ASSET_STAGES`, `assetAuditSchema` | + | CMDB |
| Spare parts inventory and reorder points | `assetRecord.stock` | = | CMDB |
| Purchase orders and line items, receiving | Infrastructure plans with a BOM (`infraPlanSchema`): plan new infra or a stack, enter BOM, target site and racks; assets created as `planned`; receiving per BOM line (`receivePlanLine`, ADR-034) takes units into stock with serials, tags, the ERP order or delivery note reference and a storage location, and keeps each receipt; discovery claims a received unit by its serial and moves it to deployed; procurement stays in the ERP and is linked by reference | ~ | CMDB |
| Layered visibility: DC, network and security, hardware, storage, virtualization, cloud, OS, containers, databases, applications, SaaS, unknown | `CI_LAYERS`, `CI_TYPE_LAYER`, per-layer visibility on every screen | + | CMDB |
| SaaS asset inventory (Microsoft 365, Salesforce, ServiceNow, Workday, Google Workspace): seats, SSO, renewals, data flows | `saas_application`, `saas_tenant`, `collectors/saas` | + | CMDB |
| Operating system inventory: family, version, patch level, end of life | Product lifecycle catalogue (bundled endoflife.date snapshot, optional tenant-enabled sync) matched to discovered OS, hypervisor and network OS releases; OS patch currency; hardware end of sale and support by model from the asset register; vendor EoX APIs under REQ-CMDB-024 (ADR-039) | + | CMDB |
| Warranty tracking with vendor API lookups (Dell, HPE, Lenovo, Cisco, IBM) | `warrantySchema`, INT integrations | = | CMDB |
| End of sale / end of support tracking (EoX) | Product lifecycle catalogue (bundled endoflife.date snapshot, optional tenant-enabled sync) matched to discovered OS, hypervisor and network OS releases; OS patch currency; hardware end of sale and support by model from the asset register; vendor EoX APIs under REQ-CMDB-024 (ADR-039) | + | CMDB |
| Support contracts, SLA level, renewal, cost | `contract` CIs (ADR-035): kind, support level and response time, start, end, days left, notice date, auto-renewal, annual cost; the contract register on the Vendors and contracts screen; an asset's support cover is the contract CI that covers it (`setAssetContract`, kept in step with `covered_by`) | = | CMDB |
| Vendors, vendor contacts, escalation paths, portals | `vendor` CIs with category, portal and account manager; contacts in escalation order with availability (`vendorContactSchema`); active contracts, covered assets and annual cost per vendor (ADR-035) | + | CMDB |
| Customers / departments / cost centres | `cost_centre` CIs of kind cost centre, department or customer, with owner and budget against the contracts billed to them; assets and plans they own (`AssetRecord.ownerCostCentre`, ADR-035) | = | CMDB |
| Contracts (general) and documents | `contract` CIs of every kind (support, maintenance, warranty extension, licence, SaaS, lease, service) with documents by reference (title and location in the organisation's document system) (ADR-035) | = | CMDB |
| Software inventory, versions, services | `software`, `software_instance`, `listening_service` | = | CMDB |
| Software licence management and compliance (per core, per user, per socket, subscriptions) | `licence` CI, compliance engine in `apps/bsm-engine` | = | CMDB |
| Certificates inventory and expiry alerts | `certificate` CIs from the certificate collector with the TLS endpoints they secure and their issuer; the Certificates screen (days left, expired, weak key or signature, self-signed); `openmap.certificate.expiring` raised once at 60, 30, 14, 7 and 1 days and on expiry by the BSM engine (ADR-036) | = | CMDB |
| Password / secret vault for device credentials | OpenBao, referenced not stored | ~ | SEC |
| Audit log of every change | outbox events `openmap.audit.action`, ClickHouse retention | = | SEC |
| Bulk import/export: CSV, Excel, API | `/import` jobs with mapping templates, `/export` CSV, XLSX, JSON | = | CMDB |
| Object merge, duplicates, reconciliation rules | reconciler identity keys, precedence by confidence, conflict events | + | CORE |
| Time-travel / history of any object | validFrom/validTo bitemporal rows, ClickHouse snapshots | + | CORE |
| Resource utilisation (CPU, memory, disk, power) | SSH, WMI and Redfish sample CPU, memory, fullest disk and power under the `utilisation.ts` names into ClickHouse; the Utilisation register (hot and idle under deployment thresholds, average and total power) and each CI's Utilisation tab with history (ADR-038) | = | CMDB |
| Cloud recommendation engine (rightsizing, unused) | analytics models over utilisation and cost | = | AI |

## 3. IPAM, DNS, DHCP, network

| Device42 feature | OpenMap | Parity | WS |
| --- | --- | --- | --- |
| Subnets, supernets, VRFs, VLANs, utilisation | `subnet`, `vrf`, `vlan` CIs, rollups | = | IPAM |
| IP addresses, reservations, DHCP ranges, conflicts | `ip_address`, `dhcp_scope`, `dhcp_lease`, conflict events | = | IPAM |
| DNS zones and records, bidirectional sync | `dns_zone`, `dns_record`, sync adapters | = | IPAM |
| Switch port management, MAC/ARP tables, port history | `interface`, `port` CIs, MAC to port mapping, history | = | IPAM |
| Network topology maps (L2/L3, LLDP/CDP) | dependency map with topology layer filter | + | DEP |
| Cabling, patch panels, circuits, cross-connects | `cable`, `patch_panel`, `power_circuit` | = | DCIM |
| Firewall rules and policy objects | `firewall_rule` CI | + | IPAM |
| IPAM API, next-free-IP, subnet allocation | GraphQL mutations, REST | = | IPAM |

## 4. DCIM

| Device42 feature | OpenMap | Parity | WS |
| --- | --- | --- | --- |
| Buildings, rooms, rows, racks, rack layouts (front/rear) | `site`, `building`, `room`, `row`, `rack`; 3D elevation | + | DCIM |
| Room layout / floor plans | isometric room view with heat colouring | + | DCIM |
| Power: PDUs, outlets, feeds, circuits, UPS, redundancy | `pdu`, `power_feed`, `power_circuit`, `ups` | = | DCIM |
| Power monitoring, thresholds, billing by outlet | `collectors/pdu` metrics, thresholds, cost allocation | = | DCIM |
| Environmental: temperature, humidity, airflow | `cooling_unit` plus sensors as attributes | = | DCIM |
| Capacity planning: space, power, cooling, ports | capacity views per room/rack | = | DCIM |
| Cable management with labels and verification | `cable` with LLDP verification status | + | DCIM |

## 5. Application dependency mapping and business services

| Device42 feature | OpenMap | Parity | WS |
| --- | --- | --- | --- |
| Application Dependency Mapping from flows, processes, listeners | `communicates_with`, `depends_on` from netflow, ss/netstat, agent | = | DEP |
| Service dependency and impact charts | impact query, blast radius panel, 100k nodes under 1 s | + | DEP |
| Business applications / affinity groups | `business_service`, `application`, `part_of_service` | = | BSM |
| Enterprise application dependency (multi-tier, cloud and on-prem) | layered map with layer filters | + | DEP |
| Service health, SLA/SLO, incident correlation, cost allocation | `apps/bsm-engine` | + | BSM |
| Change impact (planned maintenance "what if") | Impact modeling: saved scenarios (component, power, rack, site, network, storage, cloud region, shared service, maintenance), redundancy-aware propagation, predicted service state, users and revenue at risk, SLA budget effect, recovery path, recommendations (`impactScenarioSchema`, `impactSimulationSchema`) | + | BSM |
| Impact prediction accuracy | Every real incident is compared with simulations; misses become new relationships (`impactValidationSchema`) | + | BSM |
| Incident reporting to ITSM | Incidents and changes pushed to ServiceNow, Jira SM, BMC Helix, Freshservice, Zendesk with CIs, priority from tier and blast radius; resolutions close back (`incidentLinkSchema`) | + | INT |
| SIEM and SOAR integration | Splunk ES, Microsoft Sentinel, IBM QRadar, Elastic Security, Wazuh receive events with asset context; alerts resolve to CIs and services; Cortex XSOAR and Sentinel playbooks for response (`securityAlertSchema`) | + | INT |
| Delivery audit and replay for every integration message | `integrationDeliverySchema`, dead-letter queue, credential expiry warnings | + | INT |

## 6. Security, vulnerabilities, compliance

| Device42 feature | OpenMap | Parity | WS |
| --- | --- | --- | --- |
| Object vulnerabilities correlated to software versions | `vulnerability`, `affected_by`, correlation engine | = | CMDB |
| Internet-exposure and blast radius of a CVE | graph query from CVE to services | + | SEC |
| RBAC, SSO (SAML/OIDC), MFA, API tokens | Keycloak OIDC, roles and ABAC | = | SEC |
| Multi-tenancy / customers with scoped views | tenants, row-level security | + | SEC |
| Encryption at rest and in transit | TLS everywhere, Postgres and ClickHouse encryption | = | SEC |
| Air-gapped deployment | `airgap` compose profile, offline bundle | + | INT |

## 7. Analytics, reporting, AI

| Device42 feature | OpenMap | Parity | WS |
| --- | --- | --- | --- |
| Standard reports and scheduled exports | Superset dashboards and schedules | = | UI |
| DOQL (SQL over the data) | Superset SQL Lab over ClickHouse views; GraphQL | ~ | UI |
| Insights+ BI | embedded Superset, row-level filters per tenant | = | UI |
| Webhooks and notifications (email, Slack, Teams, PagerDuty) | event schema, outbox subscribers, tenant-enabled sinks | = | INT |
| AI assistant over the graph (NL to Cypher, explain impact, anomaly rules) | `apps/assistant` with local LLM | + | AI |

## 8. Integrations

| Device42 feature | OpenMap | Parity | WS |
| --- | --- | --- | --- |
| ITSM: ServiceNow, Jira Service Management, Freshservice, Zendesk, BMC Remedy, Cherwell | CMDB sync adapters and incident links | = | INT |
| Configuration management: Ansible, Puppet, Chef, SaltStack dynamic inventory | inventory endpoints and plugins | = | INT |
| Monitoring: Zabbix, Nagios, Prometheus, Datadog, SolarWinds, Splunk | event ingest and CI enrichment | = | INT |
| Infrastructure as code: Terraform provider, Pulumi | Terraform provider against GraphQL | = | INT |
| Warranty/EoX APIs: Dell, HPE, Lenovo, Cisco, IBM | asset enrichment jobs | = | INT |
| Finance/procurement: SAP, Oracle, Coupa, QuickBooks | PO and cost import adapters | + | INT |
| Identity: Active Directory, Entra ID, Okta | Keycloak federation | = | INT |
| Backup/DR awareness: Veeam, Commvault, Rubrik | `backed_by` relationships via adapters | + | INT |
| REST and GraphQL API, SDKs, OpenAPI | Mercurius GraphQL, REST, OpenAPI | = | CORE |

## 9. Onboarding and digital twin

| Device42 feature | OpenMap | Parity | WS |
| --- | --- | --- | --- |
| Initial setup wizard | Six-step onboarding: organization and business units, sites (data centre, colocation, office, branch, cloud region, edge), inter-site connectivity, Discovery Nodes and credentials, integrations and seed imports, generate twin (`organizationSchema`, `siteSchema`, `onboardingSchema`) | + | UI |
| Buildings and rooms | Sites with rooms and racks created at onboarding, kept live by discovery | = | DCIM |
| Network circuits | Inter-site links as CIs with kind, provider, bandwidth, diverse paths and role; outages modelled like any component (`siteLinkSchema`, `site_link`) | + | IPAM |
| Remote Collector install | Per-site Discovery Node enrolment with one-time token over mTLS; cloud regions are cloud-managed; branches agent-only | + | DISC |
| Seed from existing CMDB or spreadsheets | ServiceNow and CSV imports arrive as observations with their own confidence; never overwrite discovery | + | CMDB |

## 10. Platform

| Device42 feature | OpenMap | Parity | WS |
| --- | --- | --- | --- |
| Appliance deployment (VM) | single-node `docker compose`, Helm, air-gap bundle | + | INT |
| Backup and restore | scripted logical backups of all stores | = | INT |
| Health and performance of the platform itself | OpenTelemetry, Prometheus, budgets in CI | + | PERF |
| English UI | English and Arabic with RTL | + | UI |
