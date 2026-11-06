# Recorded vendor fixtures (risk R-004, REQ-DISC-001…027)

Each collector must parse at least one fixture recorded from a real product for every vendor it claims
(`packages/testing/fixtures/vendor/README.md`). These fixtures came from a container lab on 2026-11-06/07 (batch 1) and 2026-11-07 (batch 2):
real, vendor-published or distro-packaged products ran in Docker on dedicated `fxlab-*` networks. The
real OpenMap collector code ran against them, either the collector binary or its own probe, transfer
and search functions. The raw bytes were saved as the collector read them: SSH transcripts, SNMP walks,
HTTP bodies, TCP/UDP wire captures, LDAP BER, DNS AXFR messages, BSON replies, TNS packets, StartTLS dialogues, Docker Engine API bodies and PEM chains.
The one outside source is the public NVD CVE API 2.0: three small unauthenticated requests made 7 s apart.

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
| snmp | Net-SNMP snmpd 5.9.4 (Alpine 3.20) walked over SNMPv1 | `snmp/net-snmp-snmpd-alpine3.20-5.9.4-v1` | T-317 `TestREQDISC001_T317_RecordedV1Fixtures` | PASS |
| kubernetes | Docker Desktop 4.84.0, Docker Engine 29.6.2 (unix socket, read-only) | `kubernetes/docker-engine-29.6.2-desktop` | T-318 `TestREQDISC011_T318_RecordedDockerEngineFixtures` | PASS |
| kubernetes | Docker Engine 29.9.3 (docker:dind, TCP) | `kubernetes/docker-engine-29.9.3-dind` | T-318 | PASS |
| database | Oracle AI Database 26ai Free 23.26.3.0.0, CDB FREE with PDBs | `database/oracle-database-free-23.26.3.0.0` | T-319 `TestREQDISC024_T319_RecordedOracleFixtures` | PASS |
| database | Oracle AI Database 26ai Free 23.26.3.0.0, session on PDB service FREEPDB1 | `database/oracle-database-free-23.26.3.0.0-pdb-service` | T-319 | PASS |
| vulnerability_feed | NIST NVD CVE API 2.0 (Fetch window query, CVE-2014-0160, CVE-2024-3094) | `vulnerability_feed/nist-nvd-cve-api-2.0` | T-320 `TestREQDISC027_T320_RecordedNVDFixtures` | PASS |
| port_scan | xrdp 0.9.21.1 (RDP 3389) | `port_scan/neutrinolabs-xrdp-0.9.21.1` | T-321 `TestREQDISC020_T321_RecordedPortOnlyFixtures` | PASS |
| port_scan | SQL Server 2022 16.0.4305.5 (1433) | `port_scan/microsoft-sqlserver-2022-16.0.4305.5` | T-321 | PASS |
| port_scan | Oracle Database Free 23.26.3 (1521) | `port_scan/oracle-database-free-23.26.3` | T-321 | PASS |
| port_scan | kind node v1.34.0: etcd 2379, kube-apiserver 6443, kubelet 10250 (TLS) | `port_scan/kubernetes-kind-node-v1.34.0` | T-321 | PASS |
| port_scan | Exim 4.96 (SMTP) | `port_scan/exim-exim-4.96` | T-321 | PASS |
| port_scan | ProFTPD 1.3.8 | `port_scan/proftpd-proftpd-1.3.8` | T-321 | PASS |
| port_scan | Pure-FTPd 1.0.50 | `port_scan/pureftpd-pure-ftpd-1.0.50` | T-321 | PASS |
| port_scan | Samba smbd 4.17.12 (111, 139, 445) | `port_scan/samba-smbd-4.17.12` | T-321 | PASS |
| port_scan | MongoDB 8.0.34 (27017) | `port_scan/mongodb-mongodb-8.0.34` | T-321 | PASS |
| port_scan | OpenLDAP slapd 2.4.57 (389, 636 TLS) | `port_scan/openldap-slapd-2.4.57` | T-321 | PASS |
| port_scan | BIND 9.20.30 (53) | `port_scan/isc-bind-9.20.30` | T-321 | PASS |
| port_scan | Docker Engine 28.5.2 (2375) | `port_scan/docker-engine-28.5.2` | T-321 | PASS |
| port_scan | RabbitMQ 3.13.7 (AMQP 5672) | `port_scan/rabbitmq-rabbitmq-3.13.7` | T-321 | PASS |
| port_scan | OpenSearch 2.19.1 (9200) | `port_scan/opensearch-opensearch-2.19.1` | T-321 | PASS |
| netflow | softflowd 1.1.0 (NetFlow v9, IPFIX) and pmacct 1.7.8 sfprobe (sFlow v5) over IPv6 traffic | `netflow/softflowd-pmacct-ipv6-1.1.0-1.7.8` | T-322 `TestREQDISC019_T322_RecordedIPv6Fixtures` | PASS |
| certificate | Postfix 3.9.11, SMTP 25 STARTTLS | `certificate/postfix-postfix-3.9.11-starttls` | T-316 `TestREQDISC025_T316_RecordedStartTLSFixtures` | PASS |
| certificate | Postfix 3.9.11, submission 587 STARTTLS | `certificate/postfix-postfix-3.9.11-submission-starttls` | T-316 | PASS |
| certificate | Dovecot 2.3.21.1, IMAP 143 STARTTLS | `certificate/dovecot-dovecot-2.3.21.1-imap-starttls` | T-316 | PASS |
| certificate | Dovecot 2.3.21.1, POP3 110 STLS | `certificate/dovecot-dovecot-2.3.21.1-pop3-starttls` | T-316 | PASS |
| certificate | OpenLDAP slapd 2.6.10, LDAP StartTLS extended operation | `certificate/openldap-slapd-2.6.10-starttls` | T-316 | PASS |
| certificate | PostgreSQL 17.11, SSLRequest | `certificate/postgresql-postgresql-17.11-starttls` | T-316 | PASS |

T-314 (vulnerability feed, batch 1) was not used; NVD is T-320. T-323…T-349 are unused. T-313 skips the `-starttls` dirs (T-316);
T-312 skips `oracle-database-*` (T-319); T-302 skips the Docker Engine dirs (T-318); T-308 skips the T-321 dirs; T-301 skips the v1 dir
(T-317); T-307 leaves the IPv6 dir to T-322.

## Claimed vendors per row

Each row's vendors come from the tracker title and from what the collector advertises: its manifest,
vendor tables and code branches. Captured means a recorded fixture above runs through the collector.

| Row | Claimed vendor / platform | Status |
| --- | --- | --- |
| REQ-DISC-001 SNMP v1/v2c/v3 | Net-SNMP (generic MIB-II, IF-MIB, IP-MIB, LLDP-MIB) v1, v2c and v3 | captured (v1 via job option `snmpVersion: "1"`, batch 2) |
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
| | Docker Engine (new `docker_engine` collector, batch 2) | captured (Docker Desktop engine read-only, docker:dind); TLS client-cert engine not captured |
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
| REQ-DISC-019 Flow | NetFlow v5, v9, IPFIX (softflowd), sFlow v5 (pmacct sfprobe) | captured over IPv4 and IPv6 (v9, IPFIX, sFlow; NetFlow v5 cannot carry IPv6) |
| | Router/switch hardware exporters | not capturable (hardware) |
| REQ-DISC-020 Port scan | ssh, http (nginx, Apache), https, smtp (Postfix), ftp (vsftpd), pop3/imap (Dovecot), telnet, mysql (MySQL, MariaDB), redis, postgresql | captured |
| | rdp (xrdp), mssql, oracle, kubelet, etcd, kubernetes-api, Exim, ProFTPD, Pure-FTPd, smb/netbios/rpcbind, mongodb, ldap/ldaps, dns, docker, amqp, elasticsearch (OpenSearch) | captured (batch 2) |
| | winrm, MS RPC, Exchange, FileZilla Server | not capturable (Windows only) |
| | vmware-authd, proxmox, nutanix-prism | not capturable (proprietary appliances or hypervisor hosts) |
| | VNC, SIP, Kerberos, global catalog, NFS, squid, real Elasticsearch | not captured (not run in this lab) |
| REQ-DISC-021 DNS | BIND, Knot DNS, PowerDNS | captured (AXFR without TSIG; TSIG MACs cannot be replayed) |
| | Windows DNS, Infoblox, Route 53 | not capturable (licence, appliance, cloud; the collector only does AXFR) |
| REQ-DISC-022 DHCP | ISC dhcpd, Kea | captured |
| | Windows DHCP | not capturable (licence) |
| REQ-DISC-023 Directory | OpenLDAP, Samba AD DC | captured (plain LDAP, simple bind; LDAPS/StartTLS not replayable) |
| | Microsoft Active Directory | not capturable (Windows DC) |
| REQ-DISC-024 Databases | PostgreSQL, MySQL, MariaDB, SQL Server, MongoDB, Redis, Valkey | captured |
| | Oracle Database (new prober on go-ora, ADR-040, batch 2) | captured (Oracle Database Free 23ai, CDB and PDB service); Data Guard standby not capturable (Free has no Data Guard) |
| REQ-DISC-025 TLS certificates | RSA and ECDSA chains over TLS 1.3 from NGINX and HAProxy | captured |
| | StartTLS: SMTP (Postfix 25/587), IMAP and POP3 (Dovecot), LDAP (OpenLDAP), PostgreSQL SSLRequest | captured (batch 2, `startTls` option implemented) |
| REQ-DISC-026 PDU/UPS/CRAC | UPS-MIB, APC PowerNet, Raritan PX, Liebert/Vertiv, ENTITY-SENSOR-MIB | not capturable (needs real power and cooling equipment; Net-SNMP walks return noSuchObject) |
| REQ-DISC-027 Vulnerability feed | NVD CVE API 2.0 | captured (batch 2: three small public API responses; CVSS v3.0 metrics not present in them) |
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

## Collector changes in batch 2

- `internal/certificate/starttls.go` (new): the `startTls` option for SMTP, IMAP, POP3, LDAP and PostgreSQL, chosen by name or by `auto` and the well-known port. Unknown values are errors, not a silent fall back to direct TLS.
- `internal/snmp/snmp.go`: SNMPv1 via the job option `snmpVersion: "1"`. A v1 agent rejects a whole GET when any scalar is absent (noSuchName), so v1 now retries one OID at a time and drops the absent ones. Before, the real agent made the collector fail with `unsupported_device`.
- `internal/docker` + `cmd/docker_engine` (new): a Docker Engine API collector. It emits the engine as `host` with its `operating_system`, `container`, `ip_address` and `subnet` (with `vrfRef docker:<engine id>`) and `container_registry`. Relationships are runs_on, uses_ip, in_subnet, backed_by and installed_on. It never inspects containers, so environment values are never read. Images built by Compose are treated as local, so they are not linked to Docker Hub.
- `internal/database/oracle.go` (new, `github.com/sijms/go-ora/v2` v2.9.0, MIT, ADR-040): an Oracle prober reading v$instance, v$database, v$pdbs, parameters, datafiles and archive destinations. ORA-01017 is classified as `auth_failed`.
- `internal/vulnfeed/vulnfeed.go`:
  - NVD's own CVSS score is preferred over the first entry, which can be a CNA's score; the source is recorded in `cvssSource`.
  - `cpeMatches` is a string array instead of nested maps.
  - `affectedProducts` is sorted, duplicate CWEs are removed, and the CISA KEV fields are added.
- `internal/portscan/portscan.go`: an HTTP reply without a Server header on a port registered to an HTTP API service (OpenSearch/Elasticsearch on 9200) now reports that service, not plain `http`.
- `internal/haproxy/haproxy.go`: the batch-1 `members` attribute was a list of objects, which breaks the attribute rule (scalars or arrays of scalars). It is now the parallel string arrays `members`, `memberStates` and `memberAddresses`.

## Findings left open

- objectstore, Ceph RGW: `?publicAccessBlock` returns an all-false configuration even when none was set, so the collector marks every bucket `internetExposed=true`.
- objectstore, MinIO: MinIO does not implement `publicAccessBlock` (it returns 501), so the anonymous-download bucket is not flagged. Reading the bucket policy status would fix both cases; that is feature work.
- libvirt header: it claims Proxmox, which libvirt does not serve.
- docker_engine: every Docker Desktop engine is named `docker-desktop`. With `fqdn` the only identity key, engine hosts from different workstations would merge.
- docker_engine: a plain `docker build -t team/app` image is indistinguishable from a Docker Hub pull, so it is linked as `registry-assumed` (`verified: false`).
- portscan: xrdp hosts are classified `windows-host` (RDP-only hosts are guessed by port). Proxmox 8006 is probed in plaintext, though it serves HTTPS; not changed without a capture. SMB, DNS, Docker and AMQP hosts have no host class.
- Oracle via go-ora: the driver does not verify the server's login response, so jobs should use TCPS on untrusted networks (ADR-040).
