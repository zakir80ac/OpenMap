# @openmap/synth-estate

Deterministic synthetic estate generator (REQ-QA-001). It builds a realistic bank estate in memory
from a seed and a scale factor and emits it as real `CollectorResult` documents that conform to the
collector contract in `@openmap/contracts`. It is a generator of production-shaped data, not a test
double: the output goes through the same ingest path a Discovery Node uses, so reconciliation,
IPAM, DCIM, dependency mapping and BSM run against the same 100k-CI graph the performance budgets
are measured on.

## Commands

```sh
# full estate (scale 1 = SYNTH_ESTATE sizes from @openmap/constants)
pnpm --filter @openmap/synth-estate exec tsx src/cli.ts generate --seed 42 --scale 1 --out ../../packages/testing/fixtures/synth

# small estate for unit tests (runs in a few seconds)
pnpm --filter @openmap/synth-estate exec tsx src/cli.ts generate --seed 42 --scale 0.01 --out ../../packages/testing/fixtures/synth-small

# summarise an existing output directory
pnpm --filter @openmap/synth-estate exec tsx src/cli.ts stats ../../packages/testing/fixtures/synth
```

`--out` is resolved against the package directory when run through `pnpm --filter`. The generator
holds the whole estate in memory before streaming it out; scale 1 produces several hundred thousand
CIs and needs roughly 2–3 GB of heap, so run it with `NODE_OPTIONS=--max-old-space-size=6144` on a
machine where the default heap is smaller.

## Determinism

Every value comes from a seeded xoshiro128\*\* stream (`src/rng.ts`). The root stream is forked once
per generator in a fixed order (`sites`, `plan`, `facilities`, `network`, `hosts`, `virtualization`,
`storage`, `cloud`, `kubernetes`, `applications`, `edge`, `commercial`, `flows`, `emit`), so adding
a CI type to one generator does not reshuffle the others. UUIDs (tenant, jobs, runs, instance UUIDs,
cluster UIDs) are drawn from the same streams. Timestamps are offsets from a fixed epoch
(2026-10-01T00:00:00Z). The same seed and scale therefore produce byte-identical NDJSON; the test
suite asserts this by comparing SHA-256 digests of two runs.

## Shape of the estate (scale 1)

| Area | Content |
| --- | --- |
| Organization | Horizon Bank, 4 business units (Retail, Corporate, Treasury and Markets, Group Technology); the Group Technology tenant owns every collector result |
| Sites | RYD primary data centre, JED DR data centre, DMM-COLO colocation hall, HQ tower with a server room, BRANCH bundle (212 locations), Azure UAE North, AWS me-south-1 |
| Inter-site links | dark fibre and MPLS between data centres, MPLS and SD-WAN to HQ, SD-WAN to branches, ExpressRoute, Direct Connect, cloud interconnect |
| Facilities | buildings, data halls, rows, 42U racks packed bottom-up, A/B PDUs per rack on A/B power circuits fed by room UPS pairs, CRAH units per row pair |
| Network | ~5,000 devices: Nexus/Arista cores and distribution pairs per row, ToR A/B and management switch per rack, Palo Alto and Fortinet firewalls with rules, F5 load balancers, Catalyst branch routers and switches, HQ campus switches; interfaces with LLDP neighbours, VLANs, VRFs, routed /31 links |
| IPAM | one 10.0.0.0/8 root, a /12 per site, /16 pools per purpose (management, OOB, servers, VMs, storage, k8s, DMZ, links), /24 subnets created on first use; every address CI is `uses_ip`-linked to its owner and `in_subnet` to its subnet |
| Hosts | 40,000 Dell/HPE/Lenovo servers with serials, system UUIDs, MACs, BMCs on the OOB network, racked U positions, dual power feeds, two NICs cabled to the rack ToRs, OS from Ubuntu 24.04 / RHEL 9 / Windows Server 2022 / ESXi 8 (Nutanix AHV on AHV nodes), warranty dates (about a quarter expired) |
| Virtualization | vSphere, Hyper-V, Nutanix AHV and KVM clusters; 30,000 VMs with guest OS, addresses and platform MAC prefixes |
| Storage | Pure, NetApp and PowerStore arrays in storage racks, LUNs presented to hypervisor clusters, NFS shares, dual FC fabrics with Brocade/MDS switches and per-host zones, RYD to JED replication |
| Kubernetes | 6 clusters (RKE2 on VM nodes, AKS, EKS), system namespaces and workloads, 200 services |
| Applications | ~360 business applications from 40 archetypes (core banking, cards, payments, treasury, KYC/AML...) with web, api and db tiers on VMs, bare metal or Kubernetes; shared SSO; DNS, monitoring and backup infrastructure applications |
| Databases | PostgreSQL (Patroni), Oracle RAC on bare metal and SQL Server Always On clusters with databases and listeners |
| Business services | 300, each composed of 2–6 applications, tier 1–3, users, revenue per hour (SAR), RTO/RPO and SLA target |
| Software and licences | catalogue of ~40 titles with versions, instances per host and VM, licences with entitlement and consumption, some expired |
| Vulnerabilities | ~320 CVE-2026-NNNN (and some CVE-2025) records attached to software versions |
| Commercial | vendors, support contracts (some expired), cost centres, coverage of hosts, network devices and arrays |
| Edge | DNS zones with A records for every host and VM and CNAMEs per application, DHCP scopes per branch and HQ floor with leases, 214 `unknown` devices with sysDescr-like fingerprints |
| Flows | `communicates_with` edges web → api → db, api → SSO, and every compute node → DNS and monitoring |

Counts scale linearly (`round(base × scale)`, minimum 1); structural minimums (two cores, two
firewalls, three Kubernetes nodes) keep tiny estates topologically sound. Ancillary CIs
(interfaces, addresses, BMCs, operating systems, DNS records, software instances) are generated
per primary CI, so the total CI count at scale 1 is several times the 100k headline populations.

## Output layout

One NDJSON file per collector family, one validated `CollectorResult` per line:

| File | Collector id | Emits |
| --- | --- | --- |
| `snmp.ndjson` | `snmp-v3` | network_device, load_balancer, interface, vlan, vrf, firewall_rule, subnet, ip_address (management, routed) |
| `ssh_agentless.ndjson`, `wmi.ndjson` | `ssh-agentless`, `wmi` | host, operating_system, ip_address, software_instance |
| `ipmi_redfish.ndjson` | `ipmi-redfish` | bmc, ip_address |
| `vmware.ndjson`, `hyperv.ndjson`, `nutanix_ahv.ndjson`, `kvm_libvirt.ndjson` | `vmware-vcenter`, `hyperv-scvmm`, `nutanix-prism`, `kvm-libvirt` | vm_cluster, hypervisor, vm, ip_address |
| `kubernetes.ndjson` | `kubernetes` | k8s_cluster, k8s_namespace, k8s_workload, k8s_service |
| `storage.ndjson`, `fc_fabric.ndjson` | `storage-array`, `fc-fabric` | storage_array, lun, nas_share, fc_fabric, fc_switch, fc_zone |
| `pdu.ndjson` | `pdu-dcim` | site, site_link, building, room, row, rack, pdu, power_circuit, ups, cooling_unit |
| `database.ndjson` | `database` | database_cluster, database, listening_service |
| `agent.ndjson` | `agent-appmap`, `agent-sam` | application, application_component, listening_service, business_service; software, licence, vendor, contract, cost_centre, coverage relationships |
| `dns.ndjson`, `dhcp.ndjson` | `dns-bind`, `dhcp-kea` | dns_zone, dns_record, dhcp_scope, dhcp_lease |
| `port_scan.ndjson` | `port-scan` | unknown, ip_address |
| `netflow.ndjson` | `netflow-ipfix` | communicates_with relationships only |
| `cloud_azure.ndjson`, `cloud_aws.ndjson` | `cloud-azure`, `cloud-aws` | cloud_account, cloud_resource, object_bucket |
| `vulnerability_feed.ndjson` | `vulnerability-feed` | vulnerability and affected_by relationships |

Each result covers one sweep chunk of at most `PERF_BUDGETS.discoverySweepDevices` (10,000)
targets for one Discovery Node (`dn-ryd-01`, `dn-ryd-02`, `dn-jed-01`, `dn-dmm-01`, `dn-hq-01`,
`dn-branch-01`, `dn-az-uaen-01`, `dn-aws-mes1-01`). Its evidence entry carries the SHA-256 digest
and byte size of the JSON of the CIs in that result. One target in every 500 is reported as
unreachable so partial results and error handling are exercised.

Alongside the NDJSON files:

- `estate-summary.json`: counts per CI type, layer, relationship type, site and family, plus the
  file list with result, CI, relationship and byte counts.
- `services.json`: the 300 business services with tier, users, revenue per hour and the
  applications that compose them, for the BSM importer.
- `organization.json`: the `Organization`, `Site[]` and `SiteLink[]` documents for the onboarding
  wizard, validated against `@openmap/contracts`.

## How tests consume it

- Unit and integration tests generate scale 0.01 on the fly (under ten seconds) or read
  `packages/testing/fixtures/synth-small` (scale 0.05).
- The REQ-PERF-004 sweep test replays the `snmp.ndjson` results for one node, each of which is a
  10,000-device chunk, and asserts ingest finishes inside `PERF_BUDGETS.discoverySweepMinutes`.
- The REQ-PERF-002 impact test ingests the full scale-1 output, then runs impact queries from the
  tier-1 services in `services.json` against the 100k-node graph.
- Reconciliation tests rely on the identity values: every CI carries every key in
  `CI_IDENTITY_KEYS[type]`, and the same software, subnet and vendor CIs appear in several results
  so merge behaviour is exercised.
