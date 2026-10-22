# REQ-DISC-031 REQ-DISC-004 — bare-metal release build (2026-10-22)

Built with `deploy/install/build-release.sh dev .local/release linux/amd64 windows/amd64 darwin/arm64` on the dev laptop (Go 1.26, CGO disabled, -trimpath -s -w). Each tarball holds `bin/openmap-node`, `bin/openmap-agent`, 37 collectors under `collectors/`, `install/` (systemd units, launchd daemon, sh and PowerShell installers), `VERSION` and `SHA256SUMS`.

| Tarball | Bytes | Files |
| --- | --- | --- |
| openmap-dev-darwin-arm64.tar.gz | 107786441 | 48 |
| openmap-dev-linux-amd64.tar.gz | 115353281 | 48 |
| openmap-dev-windows-amd64.tar.gz | 118326241 | 48 |

## SHA256SUMS-dev

```
491b0f81da347be870778fe89dbb056eb899b231abaf6e0baf8253005c080e83 *./openmap-dev-darwin-arm64.tar.gz
5a3fc3e97482b0d8db7e589418f47e7c170f5742a6ff22553df90f6d2b93b0e6 *./openmap-dev-linux-amd64.tar.gz
c830d86b8ae6f03c719922adac5aa27fd046d025c88e53b621b59b1d5ef90a10 *./openmap-dev-windows-amd64.tar.gz
```

## Contents (linux/amd64)

```
openmap-dev-linux-amd64/SHA256SUMS
openmap-dev-linux-amd64/VERSION
openmap-dev-linux-amd64/bin/openmap-agent
openmap-dev-linux-amd64/bin/openmap-node
openmap-dev-linux-amd64/collectors/a10_thunder
openmap-dev-linux-amd64/collectors/agent
openmap-dev-linux-amd64/collectors/certificate
openmap-dev-linux-amd64/collectors/cisco_ucs
openmap-dev-linux-amd64/collectors/citrix_adc
openmap-dev-linux-amd64/collectors/cloud_alibaba
openmap-dev-linux-amd64/collectors/cloud_aws
openmap-dev-linux-amd64/collectors/cloud_azure
openmap-dev-linux-amd64/collectors/cloud_gcp
openmap-dev-linux-amd64/collectors/cloud_oci
openmap-dev-linux-amd64/collectors/database
openmap-dev-linux-amd64/collectors/dhcp
openmap-dev-linux-amd64/collectors/dns
openmap-dev-linux-amd64/collectors/fc_fabric
openmap-dev-linux-amd64/collectors/haproxy
openmap-dev-linux-amd64/collectors/hpe_oneview
openmap-dev-linux-amd64/collectors/hyperv
openmap-dev-linux-amd64/collectors/ipmi_redfish
openmap-dev-linux-amd64/collectors/kubernetes
openmap-dev-linux-amd64/collectors/kvm_libvirt
openmap-dev-linux-amd64/collectors/ldap
openmap-dev-linux-amd64/collectors/load_balancer
openmap-dev-linux-amd64/collectors/nas
openmap-dev-linux-amd64/collectors/netflow
openmap-dev-linux-amd64/collectors/nginx
openmap-dev-linux-amd64/collectors/nutanix_ahv
openmap-dev-linux-amd64/collectors/object_storage
openmap-dev-linux-amd64/collectors/oracle_vm
openmap-dev-linux-amd64/collectors/port_scan
openmap-dev-linux-amd64/collectors/saas
openmap-dev-linux-amd64/collectors/snmp
openmap-dev-linux-amd64/collectors/ssh_agentless
openmap-dev-linux-amd64/collectors/storage_ontap
openmap-dev-linux-amd64/collectors/storage_pure
openmap-dev-linux-amd64/collectors/vmware
openmap-dev-linux-amd64/collectors/vulnerability_feed
openmap-dev-linux-amd64/collectors/wmi
openmap-dev-linux-amd64/install/com.openmap.agent.plist
openmap-dev-linux-amd64/install/install-agent.ps1
openmap-dev-linux-amd64/install/install-agent.sh
openmap-dev-linux-amd64/install/install-node.ps1
openmap-dev-linux-amd64/install/install-node.sh
openmap-dev-linux-amd64/install/openmap-agent.service
openmap-dev-linux-amd64/install/openmap-node.service
```
