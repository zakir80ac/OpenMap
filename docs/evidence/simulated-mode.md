# Simulated mode (REQ-QA-005, ADR-042)

Captured 2026-11-07. **Provenance: simulated.** Every response below was rendered by `tools/simulator` from the synthetic
estate (`packages/testing/fixtures/synth-small`, seed 42). The simulators follow the vendor's published API documentation
and the collector's parser, so a pass shows that the real collector and our reading of the vendor agree. It is not a
recorded capture and closes no vendor row (risk R-004). The rows stay parked (Blocked) until real access exists.

Run: `pnpm --filter @openmap/simulator verify`. It builds every collector from `apps/collectors`, runs each against its
simulator with the same Invocation a Discovery Node sends, and compares the Result with the estate. Each simulator
package also carries a Go test (`go test ./...` in tools/simulator). Summary: `simulated-mode.json`. The full report is
written to `.local/sim-report-full.json`.

## Result

**495 of 495 runs pass with contract checks on**, across 39 simulators and 7 protocol servers:
- CIs: 66,565 of 66,565 reproduced.
- Relationships: 82,379 of 82,379 reproduced.
- Expected attribute values (where a run checks them): no mismatches.
- Every result is also checked against the CI contract as the scheduler checks it (`internal/verify/contract.go`):
  - CI and relationship types are contract enum values;
  - identities are non-empty strings;
  - attribute values are scalars or arrays of scalars.
- TLS is verified against a per-process CA (`verifyTls` + `caCertPem`) wherever the collector supports TLS.
- Authentication is real: OAuth, JWT, SigV4, OCI and Alibaba signatures, SNMPv3 USM, SSH keys with pinned host keys,
  WinRM Basic over HTTPS, LDAP binds and TSIG.

| Simulator | Collector | Rows | Test | Runs | CIs | Relationships | Identity drift (reconciler rules) |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: |
| snmp-network (Arista, Cisco NX-OS/IOS-XE, Palo Alto, Fortinet; SNMPv3 all auth/priv pairs) | snmp | REQ-DISC-001 | T-400, T-401 | 246 | 7,514 | 13,030 | 0 |
| windows-wmi (WinRM) | wmi | REQ-DISC-002 | T-370, T-374 | 1 | 7,557 | 6,921 | 0 |
| linux-ssh (RHEL, Ubuntu, VMs; password and key) | ssh_agentless | REQ-DISC-003 | T-360, T-365 | 8 | 156 | 148 | 0 |
| vmware-vcenter (`/api` and 6.x `/rest`) | vmware | REQ-DISC-005 | T-380 | 2 | 2,565 | 3,446 | 0 |
| hyperv (WinRM) | hyperv | REQ-DISC-006 | T-371 | 1 | 510 | 497 | 0 |
| kvm-libvirt (SSH) | kvm_libvirt | REQ-DISC-007 | T-361 | 2 | 20 | 18 | 0 |
| ovirt-engine (OLVM and oVirt) | oracle_vm | REQ-DISC-009, 007 | T-382 | 2 | 152 | 180 | 0 |
| nutanix-prism | nutanix_ahv | REQ-DISC-008 | T-381 | 1 | 1,134 | 2,072 | 0 |
| aws (SigV4, EC2/RDS/ELBv2/EKS/STS) | cloud_aws | REQ-DISC-010 | T-420 | 1 | 10 | 10 | 0 |
| azure (Entra token, ARM) | cloud_azure | REQ-DISC-010 | T-421 | 1 | 12 | 12 | 0 |
| gcp (JWT, Compute/SQL/GKE) | cloud_gcp | REQ-DISC-010 | T-422 | 1 | 25 | 30 | 0 |
| oci (HTTP signatures) | cloud_oci | REQ-DISC-010 | T-423 | 1 | 24 | 32 | 0 |
| alibaba (RPC and ROA signatures) | cloud_alibaba | REQ-DISC-010 | T-424 | 1 | 28 | 37 | 0 |
| kubernetes-apiserver (Kubernetes, OpenShift) | kubernetes | REQ-DISC-011 | T-383 | 2 | 156 | 250 | 0 |
| docker-engine (mutual TLS) | docker_engine | REQ-DISC-011 | T-384 | 2 | 34 | 40 | 0 |
| redfish-bmc (iDRAC9, iLO 5/6, XCC2, CIMC, DMTF) | ipmi_redfish | REQ-DISC-012 | T-390 | 10 | 20 | 20 | 0 |
| cisco-ucsm | cisco_ucs | REQ-DISC-013 | T-391 | 1 | 32 | 26 | 0 |
| hpe-oneview (718 servers, two pages) | hpe_oneview | REQ-DISC-013 | T-392 | 1 | 1,443 | 728 | 0 |
| pure-flasharray | storage_pure | REQ-DISC-014 | T-350 | 3 | 9 | 91 | 0 |
| netapp-ontap | storage_ontap | REQ-DISC-014, 016 | T-393 | 1 | 14 | 29 | 0 |
| fc-fabric (Brocade FOS, Cisco MDS over SSH) | fc_fabric | REQ-DISC-015 | T-362 | 6 | 578 | 572 | 0 |
| nas-linux-ssh (Samba, NFS) | nas | REQ-DISC-016 | T-363 | 2 | 12 | 12 | 0 |
| windows-smb (WinRM) | nas | REQ-DISC-016 | T-372 | 1 | 169 | 169 | 0 |
| s3-object-storage (MinIO, Ceph RGW, AWS; SigV4) | object_storage | REQ-DISC-017 | T-394 | 3 | 7 | 0 | 0 |
| f5-bigip | load_balancer | REQ-DISC-018 | T-430 | 6 | 302 | 358 | 112 |
| citrix-adc | citrix_adc | REQ-DISC-018 | T-431 | 2 | 246 | 270 | 94 |
| a10-thunder | a10_thunder | REQ-DISC-018 | T-432 | 1 | 22 | 26 | 9 |
| haproxy | haproxy | REQ-DISC-018 | T-433 | 2 | 84 | 100 | 22 |
| nginx (open source and Plus) | nginx | REQ-DISC-018 | T-434 | 36 | 156 | 133 | 47 |
| flow-exporter (NetFlow v5/v9, IPFIX, sFlow v5) | netflow | REQ-DISC-019 | T-410 | 4 | 14,004 | 29,664 | 0 |
| service-fingerprint (TCP banners, TLS) | port_scan | REQ-DISC-020 | T-411 | 21 | 83 | 62 | 0 |
| dns-authoritative (BIND, Windows DNS, Infoblox; AXFR, TSIG) | dns | REQ-DISC-021 | T-412, T-414 | 3 | 21,063 | 21,057 | 0 |
| dhcp-linux-ssh (ISC, Kea) | dhcp | REQ-DISC-022 | T-364 | 2 | 56 | 56 | 0 |
| windows-dhcp (WinRM) | dhcp | REQ-DISC-022 | T-373 | 1 | 28 | 28 | 0 |
| active-directory (LDAPS, StartTLS, paged) | ldap | REQ-DISC-023 | T-413 | 2 | 4,546 | 0 | 0 |
| snmp-power (APC PDUs, Schneider/Liebert UPS, Liebert cooling) | snmp | REQ-DISC-026 | T-402 | 106 | 2,338 | 2,232 | 0 |
| nvd-cve-api-2.0 | vulnerability_feed | REQ-DISC-027 | T-441 | 1 | 16 | 0 | 0 |
| saas-tenants (M365, Google, Salesforce, ServiceNow, Workday) | saas | REQ-CMDB-022 | T-440 | 5 | 19 | 23 | 0 |
| vendor-warranty (Dell, Lenovo, Cisco SN2INFO and EoX) | warranty | REQ-CMDB-024 | T-355 | 3 | 1,421 | 0 | 0 |

Harness and plumbing tests:
- T-352: harness comparison.
- T-353: contract end of life.
- T-354: warranty parsing.
- T-356: warranty planning.
- T-357: register end of life.
- T-358: plan submission.

## Collector bugs found and fixed (each with a regression test)

- **Attribute values the contract forbids (found on the full stack):** the scheduler rejected Pure results whose
  `controllers` were an array of objects. With contract checks on, the harness found twelve collectors reporting
  maps or lists of objects:
  - cloud: AWS and Azure tags and type counts, GCP labels, OCI backend sets and listeners;
  - DNS record types; FC switches and zone members; Hyper-V virtual switches;
  - Kubernetes labels, ports and selectors; NAS access; S3 storage classes;
  - ONTAP nodes, aggregates and SVMs; WMI disks and running services.

  The collector runtime now converts every attribute losslessly before the result leaves the binary: a flat map
  becomes `key=value` strings, and an object becomes compact JSON text (`collector.ContractAttributes`, T-446).
  Pure now reports a controller count plus states (T-445).
- **Manifests the API silently dropped:**
  - the contract's manifest id pattern refused the snake_case ids every collector uses;
  - OCI and Alibaba declared families the contract lacked;
  - OCI, Alibaba, GCP and Google Workspace declared credential types it lacked (`api_key`, `access_key`,
    `service_account`).

  Collector contract 0.6.0 accepts `_` in ids. It adds the `cloud_oci` and `cloud_alibaba` families and the
  `service_account` and `api_signing_key` credential types, with their vault fields and en/ar labels; Alibaba uses
  `cloud_role`. Migration 0027 adds the database enum values. T-359 checks every collector manifest against the
  contract schema.

- **Private CA ignored on token, login or API transports:** collectors behind a private CA could not connect.
  Fixed in restjson `TransportFor` (T-351) and in Pure (T-351), vmware (T-385), saas (T-442), vulnfeed (T-444),
  azure (T-426), gcp (T-427), oci (T-428), alibaba (T-429), aws (T-425), redfish (T-395), ucs (T-396),
  objectstore (T-398), nginx (T-437), haproxy (T-438), winrmexec (T-375) and directory (T-415).
- **Paging that stopped after the first page:**
  - AWS RDS, ELBv2 and EKS (T-425).
  - Alibaba RDS and the container-service cluster list, whose shape the collector could not parse (T-429).
  - Google Workspace groups (T-443).
  - NVD windows: each window is now split into ranges of at most 120 days, and the start index advances by the
    records actually returned (T-444).
- **vmware on vCenter 6.5–6.7 (`/rest`):** the `filter.` parameter prefix and key/value list shapes (T-385).
- **Identity collisions:**
  - F5 and Citrix virtual servers on one port merged into one CI (T-435, T-436).
  - An NGINX Plus zone shared its upstream's identity (T-437).
  - Several CIs were given empty `hypervisorRef` values (T-386, T-387).
  - Prism Central was counted as a cluster (T-386).
  - The Linux OS family was set per distribution where every other collector uses "linux" (T-366).
  - SaaS vendor CIs were named after the adapter key instead of the company (T-443).
- **Wrong fields:**
  - UCS read the wrong CIMC address attribute, `externalIp` instead of `extIp` (T-396).
  - OneView named hosts after the iLO and summed cores incorrectly (T-397).
  - Redfish took `HostName` as an FQDN, and iLO power supplies collapsed into one (T-395).
  - A10 reported the raw target URL as the management IP (T-439).
  - Liebert UPSs were classified as cooling units (T-403).
  - Windows NAS and DHCP keyed servers on the target address instead of their DNS name, and Windows DHCP options were
    never parsed (T-376, T-377).
  - The port scanner left unlisted web ports `unknown` (T-416).

## Full stack: Discovery Node, scheduler, reconciler, console

On the compose stack (`docker-compose.simulated.yml`, profile `simulated`):
1. The simulator container served the plan.
2. `scheduler plan:submit` stored the simulated credentials in OpenBao under `simulated/` and scheduled the
   warranty, SaaS and Pure jobs on `node-compose-01`.
3. The real Node ran the real collectors in the synthetic tenant.

Results:
- **Warranty:** the asset register now carries vendor-verified warranty (`source: vendor_api`, `verifiedAt` set) for
  all 769 Dell servers, 517 Lenovo servers and 135 Cisco devices. 124 of the Cisco devices also carry a vendor end of
  life. The Lifecycle screen's hardware view shows the Cisco models dated, for example Nexus 9364C-GX: end of sale
  2025-03-03, end of support 2031-03-03 (`console/simulated-lifecycle-hardware-en.png`, `-ar.png`).
- **SaaS:** the five tenants were rediscovered (`console/simulated-saas-en.png`, `-ar.png`). At the time, tenant ids
  differed between the estate (UUIDs) and the simulator (vendor-shaped ids), so four tenants and nine subscriptions
  were added rather than merged. ADR-044 gives the estate vendor-shaped ids, and the simulator now serves them.

The dev tenant now holds these simulated results. Replaying the estate with `--reset` restores it.

## Identity drift: synthetic estate against real collectors (resolved by ADR-044)

Drift counts matched CIs whose collector identity reconciliation would not merge into the estate's CI. It is judged
with the reconciler's own rules: an observation merges when its full identity tuple is equal, or when any globally
unique key carries the same value. The harness reads those rules from `packages/contracts/schemas/ci-identity.json`.
Relationship drift counts emitted links between two estate CIs that the estate links with another type or direction.

| Estate | Identity drift | Relationship drift |
| --- | ---: | ---: |
| Before ADR-044 | 7,894 | 524 |
| After ADR-044 | 284 | 0 |

The figure of 36,373 reported earlier came from a stricter check. It flagged an IP address filed under another VRF,
which reconciliation still merges on the address.

What changed in the generator, each following the collector named:
- **SNMP:** interfaces, VLANs, VRFs and firewall rules point at their device as `serial:<serial>`.
- **vCenter, Prism, Hyper-V, libvirt and oVirt:**
  - hypervisors are keyed by the host FQDN and the platform's own id;
  - clusters are keyed by vCenter's `domain-c<n>`, Prism's UUID or Hyper-V's GUID;
  - the links read `hypervisor hosted_on host` and `vm runs_on hypervisor`.
- **WMI and Hyper-V:** a Windows OS identity carries its build (`10.0.20348`). Every OS is `installed_on` its host.
- **SSH, WMI and the agent:** a software instance names its software `name@version` and is `member_of` it.
- **DNS:** CNAME targets carry the trailing dot.
- **Pure and ONTAP:** LUN WWNs carry the array's NAA OUI.
- **AWS:** ARNs follow each service's form.
- **Brocade and MDS:** a fabric takes its principal switch's WWN.
- **SaaS:** tenant ids take each vendor's shape, and products the name the vendor API reports.
- **Kubernetes:** Services depend on the workloads their selector matches, and tiers are labelled per component.

Where the collectors disagreed among themselves, the majority form was adopted and the outliers were changed:
- SSH now links an OS `installed_on` its host.
- WMI's software links now match SSH's and the agent's.
- SSH and the agent now link an instance to its software (`member_of`).
- The agent's `softwareRef` is now `name@version`.

What is left:
- **Load-balancer pool members (284):** the load balancer keys a member's listener by its IP or FQDN; the host's own
  collector keys it by the host serial. One estate value cannot match both observers. Closing it needs reconciliation to
  resolve `*Ref` values to the referenced CI.
- **Active Directory computers:** the LDAP collector types a computer `host`, because a directory cannot tell a VM from
  a server. A VM is still found once by its hypervisor collector and once by the directory.

## Not simulated, and why

- **No collector exists to drive:**
  - HPE and IBM warranty APIs (no documented shape we could confirm).
  - Tenable, Qualys and Rapid7 imports (the collector only speaks NVD 2.0).
  - Infoblox WAPI and Route 53 (the DNS collector speaks AXFR).
- **The collector does not read the product's MIB:**
  - Vertiv Geist PDUs and Schneider Uniflair cooling units.
- **Proxmox:** it has no libvirt, so the kvm_libvirt collector would report it as unsupported.
- **Port numbers only:** the simulator uses ephemeral ports, so services recognisable only by their port number stay
  covered by the recorded fixtures (T-308, T-321).
- **REQ-DISC-004 and 031:** the agent and the Remote Collector install wait on the code-signing decision, which
  simulation does not change.
