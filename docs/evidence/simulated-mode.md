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

**495 of 495 runs pass**, across 39 simulators and 7 protocol servers:
- CIs: 66,565 of 66,565 reproduced.
- Relationships: 82,331 of 82,331 reproduced.
- Expected attribute values (where a run checks them): no mismatches.
- TLS is verified against a per-process CA (`verifyTls` + `caCertPem`) wherever the collector supports TLS.
- Authentication is real: OAuth, JWT, SigV4, OCI and Alibaba signatures, SNMPv3 USM, SSH keys with pinned host keys,
  WinRM Basic over HTTPS, LDAP binds and TSIG.

| Simulator | Collector | Rows | Test | Runs | CIs | Relationships | Identity drift |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: |
| snmp-network (Arista, Cisco NX-OS/IOS-XE, Palo Alto, Fortinet; SNMPv3 all auth/priv pairs) | snmp | REQ-DISC-001 | T-400, T-401 | 246 | 7,514 | 13,030 | 6,573 |
| windows-wmi (WinRM) | wmi | REQ-DISC-002 | T-370, T-374 | 1 | 7,557 | 6,921 | 1,580 |
| linux-ssh (RHEL, Ubuntu, VMs; password and key) | ssh_agentless | REQ-DISC-003 | T-360, T-365 | 8 | 156 | 100 | 2 |
| vmware-vcenter (`/api` and 6.x `/rest`) | vmware | REQ-DISC-005 | T-380 | 2 | 2,565 | 3,446 | 1,729 |
| hyperv (WinRM) | hyperv | REQ-DISC-006 | T-371 | 1 | 510 | 497 | 190 |
| kvm-libvirt (SSH) | kvm_libvirt | REQ-DISC-007 | T-361 | 2 | 20 | 18 | 0 |
| ovirt-engine (OLVM and oVirt) | oracle_vm | REQ-DISC-009, 007 | T-382 | 2 | 152 | 180 | 0 |
| nutanix-prism | nutanix_ahv | REQ-DISC-008 | T-381 | 1 | 1,134 | 2,072 | 1,009 |
| aws (SigV4, EC2/RDS/ELBv2/EKS/STS) | cloud_aws | REQ-DISC-010 | T-420 | 1 | 10 | 10 | 2 |
| azure (Entra token, ARM) | cloud_azure | REQ-DISC-010 | T-421 | 1 | 12 | 12 | 0 |
| gcp (JWT, Compute/SQL/GKE) | cloud_gcp | REQ-DISC-010 | T-422 | 1 | 25 | 30 | 0 |
| oci (HTTP signatures) | cloud_oci | REQ-DISC-010 | T-423 | 1 | 24 | 32 | 0 |
| alibaba (RPC and ROA signatures) | cloud_alibaba | REQ-DISC-010 | T-424 | 1 | 28 | 37 | 0 |
| kubernetes-apiserver (Kubernetes, OpenShift) | kubernetes | REQ-DISC-011 | T-383 | 2 | 156 | 250 | 0 |
| docker-engine (mutual TLS) | docker_engine | REQ-DISC-011 | T-384 | 2 | 34 | 40 | 0 |
| redfish-bmc (iDRAC9, iLO 5/6, XCC2, CIMC, DMTF) | ipmi_redfish | REQ-DISC-012 | T-390 | 10 | 20 | 20 | 8 |
| cisco-ucsm | cisco_ucs | REQ-DISC-013 | T-391 | 1 | 32 | 26 | 0 |
| hpe-oneview (718 servers, two pages) | hpe_oneview | REQ-DISC-013 | T-392 | 1 | 1,443 | 728 | 0 |
| pure-flasharray | storage_pure | REQ-DISC-014 | T-350 | 3 | 9 | 91 | 6 |
| netapp-ontap | storage_ontap | REQ-DISC-014, 016 | T-393 | 1 | 14 | 29 | 3 |
| fc-fabric (Brocade FOS, Cisco MDS over SSH) | fc_fabric | REQ-DISC-015 | T-362 | 6 | 578 | 572 | 118 |
| nas-linux-ssh (Samba, NFS) | nas | REQ-DISC-016 | T-363 | 2 | 12 | 12 | 0 |
| windows-smb (WinRM) | nas | REQ-DISC-016 | T-372 | 1 | 169 | 169 | 0 |
| s3-object-storage (MinIO, Ceph RGW, AWS; SigV4) | object_storage | REQ-DISC-017 | T-394 | 3 | 7 | 0 | 1 |
| f5-bigip | load_balancer | REQ-DISC-018 | T-430 | 6 | 302 | 358 | 224 |
| citrix-adc | citrix_adc | REQ-DISC-018 | T-431 | 2 | 246 | 270 | 188 |
| a10-thunder | a10_thunder | REQ-DISC-018 | T-432 | 1 | 22 | 26 | 15 |
| haproxy | haproxy | REQ-DISC-018 | T-433 | 2 | 84 | 100 | 44 |
| nginx (open source and Plus) | nginx | REQ-DISC-018 | T-434 | 36 | 156 | 133 | 94 |
| flow-exporter (NetFlow v5/v9, IPFIX, sFlow v5) | netflow | REQ-DISC-019 | T-410 | 4 | 14,004 | 29,664 | 14,000 |
| service-fingerprint (TCP banners, TLS) | port_scan | REQ-DISC-020 | T-411 | 21 | 83 | 62 | 0 |
| dns-authoritative (BIND, Windows DNS, Infoblox; AXFR, TSIG) | dns | REQ-DISC-021 | T-412, T-414 | 3 | 21,063 | 21,057 | 10,557 |
| dhcp-linux-ssh (ISC, Kea) | dhcp | REQ-DISC-022 | T-364 | 2 | 56 | 56 | 24 |
| windows-dhcp (WinRM) | dhcp | REQ-DISC-022 | T-373 | 1 | 28 | 28 | 0 |
| active-directory (LDAPS, StartTLS, paged) | ldap | REQ-DISC-023 | T-413 | 2 | 4,546 | 0 | 0 |
| snmp-power (APC PDUs, Schneider/Liebert UPS, Liebert cooling) | snmp | REQ-DISC-026 | T-402 | 106 | 2,338 | 2,232 | 0 |
| nvd-cve-api-2.0 | vulnerability_feed | REQ-DISC-027 | T-441 | 1 | 16 | 0 | 0 |
| saas-tenants (M365, Google, Salesforce, ServiceNow, Workday) | saas | REQ-CMDB-022 | T-440 | 5 | 19 | 23 | 6 |
| vendor-warranty (Dell, Lenovo, Cisco SN2INFO and EoX) | warranty | REQ-CMDB-024 | T-355 | 3 | 1,421 | 0 | 0 |

Harness and plumbing tests:
- T-352: harness comparison.
- T-353: contract end of life.
- T-354: warranty parsing.
- T-356: warranty planning.
- T-357: register end of life.
- T-358: plan submission.

## Collector bugs found and fixed (each with a regression test)

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

## Identity drift: synthetic estate against real collectors (open finding)

Drift counts matched CIs whose collector identity would not merge with the estate's CI, so real discovery against this
estate would create second records. The collectors report what the products return; the estate generator diverges:

- **VRF of IP addresses:** the estate files addresses under `PROD`, `MGMT` or `STORAGE`. SNMP, WMI, flows, DNS, ONTAP
  and the load balancers report `default`.
- **Virtualisation ids:**
  - The estate keys clusters by name, where vCenter, Prism and Hyper-V use their own ids.
  - It keys hypervisors by serial, where the collectors use the host name.
  - It keys VMs by the internal id of their hypervisor.
  - Its relationship directions (`hosted_on`, `runs_on`) are the reverse of all four hypervisor collectors.
- **SNMP interfaces and VLANs:** the estate's `deviceRef` is the bare serial; the collector writes `serial:<serial>`.
- **Load balancer pool members:** the estate keys them by VM instance UUID; the collectors key them by IP or FQDN.
- **Smaller differences:**
  - DNS CNAME values: the collector keeps the trailing dot; the estate drops it.
  - Pure WWNs: the estate omits the `624a9370` prefix.
  - AWS ARNs: the estate uses formats AWS doesn't.
  - Windows OS versions: the estate writes `2022` where Windows reports `10.0.20348`.
  - Software references: the estate writes `Vendor/Name/Version`, the collectors `name@version`.
  - Active Directory computers: the collector types them `host`; the estate has the same machines as `vm`.

Aligning the generator with the collectors, or deciding a convention where they disagree among themselves (the SNMP
`deviceRef`, the VRF of discovered addresses), is a follow-up. It changes estate values, so it needs a decision.

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
