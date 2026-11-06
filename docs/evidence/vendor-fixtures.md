# Recorded vendor fixtures (risk R-004, REQ-DISC-001…027)

Each collector must parse at least one fixture recorded from a real product for every vendor it claims
(`packages/testing/fixtures/vendor/README.md`). These fixtures came from a container lab on 2026-11-06/07:
real, vendor-published or distro-packaged products ran in Docker on dedicated `fxlab-*` networks. The
real OpenMap collector code ran against them, either the collector binary or its own probe, transfer
and search functions. The raw bytes were saved as the collector read them: SSH transcripts, SNMP walks,
HTTP bodies, TCP/UDP wire captures, LDAP BER, DNS AXFR messages, BSON replies and PEM chains.

Each fixture directory has a `manifest.json` with the image, digest, exact command and redactions.
`packages/testing/fixtures/vendor/.gitattributes` (`* -text`) keeps every capture byte-exact in git.
The tests replay recorded server bytes only where the collector's entry point is network-bound.
HTTP is replayed through httptest. TCP replay serves the recorded server side in order, and DNS
replay rewrites only the message ID. Each test runs the collector's real parse, decode and emit code
and asserts concrete CIs and relationships.

Result column: `go test -count=3 -run REQDISC ./internal/...` in `apps/collectors`, all PASS. The full
`go test ./...` and `go vet ./...` also pass, and so does `pnpm guard`.

## Fixtures

| Family | Vendor / product / version | Fixture dir (under `packages/testing/fixtures/vendor/`) | Test | Result |
| --- | --- | --- | --- | --- |
| ssh_agentless | Canonical Ubuntu 24.04.5 LTS | `ssh_agentless/canonical-ubuntu-24.04.5` | T-300 `TestREQDISC003_T300_RecordedVendorFixtures` | PASS |
| ssh_agentless | Debian GNU/Linux 12 | `ssh_agentless/debian-debian-12` | T-300 | PASS |
| ssh_agentless | AlmaLinux 9.8 (RHEL 9 rebuild) | `ssh_agentless/almalinux-almalinux-9.8` | T-300 | PASS |
| ssh_agentless | Alpine Linux 3.20.10 (BusyBox) | `ssh_agentless/alpine-alpine-3.20.10` | T-300 | PASS |
| ssh_agentless | Amazon Linux 2023.12.20261102 | `ssh_agentless/aws-amazonlinux-2023.12.20261102` | T-300 | PASS |
| snmp | Net-SNMP snmpd 5.9.3 (Debian 12, lldpd AgentX), v2c + v3 authPriv | `snmp/net-snmp-snmpd-debian12-5.9.3` | T-301 `TestREQDISC001_T301_RecordedVendorFixtures` | PASS |
| snmp | Net-SNMP snmpd 5.9.4 (Alpine 3.20), v2c + v3 authPriv | `snmp/net-snmp-snmpd-alpine3.20-5.9.4` | T-301 | PASS |
| kubernetes | kind v1.34.0 (cluster `openmap`) | `kubernetes/kind-kind-v1.34.0` | T-302 `TestREQDISC011_T302_RecordedVendorFixtures` | PASS |
| kubernetes | K3s v1.34.1+k3s1 | `kubernetes/k3s-k3s-v1.34.1+k3s1` | T-302 | PASS |
| nas | Samba 4.17.12 + knfsd `exportfs` (Debian 12) | `nas/samba-samba-4.17.12` | T-303 `TestREQDISC016_T303_RecordedVendorFixtures` | PASS |
| nas | Linux nfs-utils rpc.mountd 2.6.2 + rpcbind 1.2.6 (MOUNT RPC) | `nas/linux-nfs-utils-2.6.2` | T-303 | PASS |
| nas | NFS-Ganesha 4.3 (MOUNT RPC) | `nas/nfs-ganesha-nfs-ganesha-4.3` | T-303 | PASS |
| object_storage | MinIO RELEASE.2025-09-07T16-13-09Z | `object_storage/minio-minio-RELEASE.2025-09-07T16-13-09Z` | T-304 `TestREQDISC017_T304_RecordedVendorFixtures` | PASS |
| object_storage | Ceph RGW 18.2.4 reef | `object_storage/ceph-rgw-18.2.4-reef` | T-304 | PASS |
| load_balancer | HAProxy 3.2.26 (default stats CSV) | `load_balancer/haproxy-haproxy-3.2.26` | T-305 `TestREQDISC018_T305_RecordedVendorFixtures` | PASS |
| load_balancer | HAProxy 2.8.31 (`stats show-legends`) | `load_balancer/haproxy-haproxy-2.8.31-show-legends` | T-305 | PASS |
| load_balancer | NGINX Open Source 1.29.5 (stub_status) | `load_balancer/nginx-nginx-1.29.5` | T-306 `TestREQDISC018_T306_RecordedVendorFixtures` | PASS |
| netflow | softflowd 1.1.0: NetFlow v5, v9, IPFIX | `netflow/softflowd-softflowd-1.1.0` | T-307 `TestREQDISC019_T307_RecordedVendorFixtures` | PASS |
| netflow | pmacct 1.7.8 pmacctd sfprobe: sFlow v5 | `netflow/pmacct-pmacctd-sfprobe-1.7.8` | T-307 | PASS |
| port_scan | Alpine 3.20 host: OpenSSH 9.7p1, Postfix 3.9.11, vsftpd 3.0.5, Dovecot 2.3.21.1, BusyBox telnetd | `port_scan/alpinelinux-linux-host-3.20` | T-308 `TestREQDISC020_T308_RecordedVendorFixtures` | PASS |
| port_scan | nginx 1.31.8 (HTTP + HTTPS) | `port_scan/nginx-nginx-1.31.8` | T-308 | PASS |
| port_scan | Apache httpd 2.4.69 | `port_scan/apache-httpd-2.4.69` | T-308 | PASS |
| port_scan | MySQL 8.4.13 | `port_scan/oracle-mysql-8.4.13` | T-308 | PASS |
| port_scan | MariaDB 11.8.9 | `port_scan/mariadb-mariadb-11.8.9` | T-308 | PASS |
| port_scan | Redis 7.4.12 | `port_scan/redis-redis-7.4.12` | T-308 | PASS |
| port_scan | PostgreSQL 17.11 | `port_scan/postgresql-postgresql-17.11` | T-308 | PASS |
| dns | ISC BIND 9.20.30 (forward + reverse AXFR) | `dns/isc-bind-9.20.30` | T-309 `TestREQDISC021_T309_RecordedVendorFixtures` | PASS |
| dns | CZ.NIC Knot DNS 3.4.11 | `dns/cznic-knot-3.4.11` | T-309 | PASS |
| dns | PowerDNS Authoritative 4.9.18 | `dns/powerdns-authoritative-4.9.18` | T-309 | PASS |
| dhcp | ISC dhcpd 4.4.3-P1 (real udhcpc leases) | `dhcp/isc-dhcpd-4.4.3-P1` | T-310 `TestREQDISC022_T310_RecordedVendorFixtures` | PASS |
| dhcp | ISC Kea DHCPv4 2.2.0 (memfile) | `dhcp/isc-kea-dhcp4-2.2.0` | T-310 | PASS |
| ldap | OpenLDAP slapd 2.6.10 | `ldap/openldap-slapd-2.6.10` | T-311 `TestREQDISC023_T311_RecordedVendorFixtures` | PASS |
| ldap | Samba AD DC 4.17.12 | `ldap/samba-ad-dc-4.17.12` | T-311 | PASS |
| database | PostgreSQL 17.11 primary (with streaming replica) | `database/postgresql-postgresql-17.11-primary` | T-312 `TestREQDISC024_T312_RecordedVendorFixtures` | PASS |
| database | PostgreSQL 17.11 hot-standby replica | `database/postgresql-postgresql-17.11-replica` | T-312 | PASS |
| database | MySQL Community 8.4.13 GTID source | `database/oracle-mysql-8.4.13-primary` | T-312 | PASS |
| database | MySQL Community 8.4.13 GTID replica | `database/oracle-mysql-8.4.13-replica` | T-312 | PASS |
| database | MariaDB 11.4.13 | `database/mariadb-mariadb-11.4` | T-312 | PASS |
| database | SQL Server 2022 Developer 16.0.4305.5 (Linux) | `database/microsoft-sqlserver-2022-16.0.4305.5` | T-312 | PASS |
| database | MongoDB 8.0.34 replica-set primary | `database/mongodb-mongodb-8.0.34-primary` | T-312 | PASS |
| database | MongoDB 8.0.34 replica-set secondary | `database/mongodb-mongodb-8.0.34-secondary` | T-312 | PASS |
| database | Redis 7.4.12 master (with replica) | `database/redis-redis-7.4.12-primary` | T-312 | PASS |
| database | Redis 7.4.12 replica | `database/redis-redis-7.4.12-replica` | T-312 | PASS |
| database | Valkey 8.1.10 | `database/valkey-valkey-8.1.10` | T-312 | PASS |
| certificate | NGINX 1.29.5 TLS 1.3, RSA chain (root, intermediate, leaf) | `certificate/nginx-nginx-1.29.5` | T-313 `TestREQDISC025_T313_RecordedVendorFixtures` | PASS |
| certificate | HAProxy 3.2.26 TLS 1.3, ECDSA chain | `certificate/haproxy-haproxy-3.2.26` | T-313 | PASS |
| kvm_libvirt | libvirt 9.0.0 + QEMU 7.2.22 (TCG), one running and one stopped domain | `kvm_libvirt/libvirt-libvirt-9.0.0` | T-315 `TestREQDISC007_T315_RecordedVendorFixtures` | PASS |

T-314 (vulnerability feed) and T-316…T-349 are unused; no fixture was capturable for them (see below).

## Claimed vendors per row

Each row's vendors come from the tracker title and from what the collector advertises: its manifest,
vendor tables and code branches. Captured means a recorded fixture above runs through the collector.

| Row | Claimed vendor / platform | Status |
| --- | --- | --- |
| REQ-DISC-001 SNMP v1/v2c/v3 | Net-SNMP (generic MIB-II, IF-MIB, IP-MIB, LLDP-MIB) v2c and v3 | captured |
| | SNMP v1 | not captured (lab agents were walked over v2c/v3 only) |
| | ENTITY-MIB serials, Q-BRIDGE VLANs | not capturable (Net-SNMP on Linux implements no agent for them) |
| | Cisco, Arista, Juniper, HPE/H3C, Fortinet, Palo Alto, Brocade, Dell, HPE ProLiant (sysObjectID table) | not capturable (proprietary hardware or licensed images) |
| REQ-DISC-002 WMI/WinRM | Windows Server | not capturable (licence) |
| REQ-DISC-003 SSH Linux/Unix | Ubuntu, Debian (dpkg), AlmaLinux/RHEL family, Amazon Linux (rpm), Alpine (apk/BusyBox) | captured |
| | AIX, Solaris, HP-UX | not capturable (proprietary OS/hardware; the script is Linux-only) |
| REQ-DISC-004 Device42 agent | Windows, Linux, macOS agent | out of scope for this lab |
| REQ-DISC-005 VMware | vCenter/ESXi | not capturable (licence) |
| REQ-DISC-006 Hyper-V | Hyper-V / SCVMM | not capturable (licence) |
| REQ-DISC-007 KVM/libvirt, oVirt, Proxmox | KVM/QEMU via libvirt | captured (guest-agent OS/IP paths untested: no guest OS image) |
| | oVirt/OLVM (`internal/ovirt`) | not capturable (needs a full engine plus hosts) |
| | Proxmox VE | not capturable, and not served by the libvirt collector (Proxmox uses `qm`, not libvirt); needs its own collector |
| REQ-DISC-008 Nutanix | Prism | not capturable (proprietary) |
| REQ-DISC-009 Oracle VM / OLVM | OVM Manager / OLVM | not capturable |
| REQ-DISC-010 Cloud | AWS, Azure, GCP, OCI, Alibaba | not capturable (cloud accounts) |
| REQ-DISC-011 Kubernetes/OpenShift/Docker | Kubernetes (kind), K3s | captured |
| | OpenShift, EKS, AKS, GKE | not capturable (proprietary or cloud) |
| | Docker Engine | no collector reads the Docker Engine API; nothing to capture |
| REQ-DISC-012 IPMI/Redfish | iLO, iDRAC, XClarity, CIMC, generic BMC | not capturable (hardware) |
| REQ-DISC-013 Blade/UCS/OneView | Cisco UCS, HPE OneView | not capturable (hardware) |
| REQ-DISC-014 Storage arrays | Pure, NetApp, Dell EMC, HPE, IBM, Hitachi | not capturable (hardware) |
| REQ-DISC-015 FC fabric | Brocade, Cisco MDS | not capturable (hardware) |
| REQ-DISC-016 NAS SMB/NFS | Samba, Linux knfsd export table, Linux rpc.mountd, NFS-Ganesha | captured |
| | Windows SMB (Get-SmbShare over WinRM) | not capturable (licence) |
| | NetApp ONTAP / Dell PowerScale NFS | not capturable (appliances) |
| REQ-DISC-017 Object storage | MinIO, Ceph RGW | captured |
| | AWS S3, Dell ECS, NetApp StorageGRID | not capturable (cloud or proprietary) |
| REQ-DISC-018 Load balancers | HAProxy (two versions), NGINX Open Source stub_status | captured |
| | NGINX Plus API | not capturable (commercial) |
| | F5 BIG-IP, Citrix ADC, A10 | not capturable (proprietary) |
| REQ-DISC-019 Flow | NetFlow v5, v9, IPFIX (softflowd), sFlow v5 (pmacct sfprobe) | captured (IPv4 flows only; IPv6 decode paths not covered) |
| | Router/switch hardware exporters | not capturable (hardware) |
| REQ-DISC-020 Port scan | ssh, http (nginx, Apache), https, smtp (Postfix), ftp (vsftpd), pop3/imap (Dovecot), telnet, mysql (MySQL, MariaDB), redis, postgresql | captured |
| | Exim, Exchange, FileZilla, ProFTPD banners; port-only classes (proxmox, vmware-authd, nutanix-prism, kubelet, winrm, rdp, mssql, oracle) | not captured (licensed, or not run in this lab) |
| REQ-DISC-021 DNS | BIND, Knot DNS, PowerDNS | captured (AXFR without TSIG; TSIG MACs cannot be replayed) |
| | Windows DNS, Infoblox, Route 53 | not capturable (licence, appliance, cloud; the collector only does AXFR) |
| REQ-DISC-022 DHCP | ISC dhcpd, Kea | captured |
| | Windows DHCP | not capturable (licence) |
| REQ-DISC-023 Directory | OpenLDAP, Samba AD DC | captured (plain LDAP, simple bind; LDAPS/StartTLS not replayable) |
| | Microsoft Active Directory | not capturable (Windows DC) |
| REQ-DISC-024 Databases | PostgreSQL, MySQL, MariaDB, SQL Server, MongoDB, Redis, Valkey | captured |
| | Oracle Database | not capturable: the collector has no Oracle prober (claimed by the title only; needs a new driver dependency) |
| REQ-DISC-025 TLS certificates | RSA and ECDSA chains over TLS 1.3 from NGINX and HAProxy | captured |
| | StartTLS endpoints | not capturable (the `startTls` option is not implemented by `Probe`) |
| REQ-DISC-026 PDU/UPS/CRAC | UPS-MIB, APC PowerNet, Raritan PX, Liebert/Vertiv, ENTITY-SENSOR-MIB | not capturable (needs real power and cooling equipment; Net-SNMP walks return noSuchObject) |
| REQ-DISC-027 Vulnerability feed | NVD CVE API 2.0 | not capturable offline (public service; no NVD download or API call was made) |
| | Tenable, Qualys, Rapid7 imports | not capturable, and the collector has no code path for them |

## Collector fixes the fixtures exposed

- `internal/sshlinux/parse.go`: `ParseSS` now reads the `netstat -ltunp` fallback (BusyBox Alpine) and treats tcp6/udp6 as tcp/udp. Before, every TCP listener was dropped there.
- `internal/sshlinux/emit.go`: loopback-only sockets across 127/8 are skipped (Docker's 127.0.0.11 resolver used to become a service). IPv4 and IPv6 sockets of one daemon now give one `listening_service`, not two CIs with the same identity.
- `internal/libvirt/libvirt.go`: `Script()` exports `LIBVIRT_DEFAULT_URI=${LIBVIRT_DEFAULT_URI:-qemu:///system}`. A non-root login used to inventory its own empty session daemon.
- `internal/snmp/parse.go`: loopback addresses are no longer emitted as `ip_address` CIs. The LLDP local port ID with MAC subtype is now formatted as a MAC.
- `internal/snmp/emit.go`: `ip_address` identities now carry `vrfRef: default`, the contract identity key used by the other collectors.
- `internal/netflow/netflow.go`: `Aggregate` treats destination ports from 32768 (Linux ephemeral range) or well-known source ports as replies. Each conversation now folds into one edge.
- `internal/portscan/portscan.go`: the FTP rule matches product names case-insensitively, so vsFTPd is no longer reported as "FTP". The MySQL/MariaDB version is read from the raw handshake instead of the printable banner.
- `internal/haproxy/haproxy.go`: a `listen` section's frontend gets a `#frontend` identity suffix (it used to depend on itself). Pools carry a `members` attribute, because HAProxy hides server addresses unless `stats show-legends` is set.
- `internal/kubernetes/kubernetes.go`: `distribution()` recognises `kind://` provider IDs.
- `internal/database/mongodb.go`: the probe is split into running the commands and building the inventory, so the replies can be recorded. `asDocument` accepts the bson.D nested documents that driver v2 returns; before, databases, connections and the storage engine were all missing.
- `internal/database/postgres.go`: the `/32` mask is stripped from `pg_stat_replication.client_addr`. Replica IPs and `replicates_to` were missing before.
- `internal/database/mssql.go`: `user connections` = 0 is reported as the engine maximum, 32767.
- `internal/database/redis.go`: keyspaces are sorted so every run emits the same order.

## Findings left open

- objectstore, Ceph RGW: `?publicAccessBlock` returns an all-false configuration even when none was set, so the collector marks every bucket `internetExposed=true`.
- objectstore, MinIO: MinIO does not implement `publicAccessBlock` (it returns 501), so the anonymous-download bucket is not flagged. Reading the bucket policy status would fix both cases; that is feature work.
- certificate: the `startTls` option is declared but not implemented.
- libvirt header: it claims Proxmox, which libvirt does not serve.
- Oracle Database: claimed by REQ-DISC-024 but has no prober.
