# Collector families

Generated from each collector binary's `--manifest` (`apps/collectors/cmd/<family>`). Credentials are OpenBao references resolved by the Node; collectors never see the vault. Every family emits the CI types listed and records raw evidence by SHA-256 digest.

| Collector | Family | Protocols | Credential types | Target kinds | Emits |
| --- | --- | --- | --- | --- | --- |
| `certificate` | certificate | tls | none | host, url | certificate, listening_service |
| `cloud_aws` | cloud_aws | https | api_token, cloud_role | account | cloud_account, cloud_resource, vm, subnet, ip_address, database_cluster, load_balancer |
| `cloud_azure` | cloud_azure | https | oauth_client | account | cloud_account, cloud_resource, vm, subnet, ip_address, operating_system |
| `database` | database | postgresql, mysql, tds, mongodb, resp | password, none | host | database_cluster, database, listening_service, ip_address |
| `dhcp` | dhcp | winrm, ssh | password, ssh_key | host | dhcp_scope, dhcp_lease, ip_address |
| `dns` | dns | dns-axfr | none, api_token | host | dns_zone, dns_record, ip_address |
| `fc_fabric` | fc_fabric | ssh | password, ssh_key | host | fc_switch, fc_fabric, fc_zone, port |
| `hyperv` | hyperv | winrm | password | host | vm_cluster, hypervisor, host, vm, operating_system, ip_address |
| `ipmi_redfish` | ipmi_redfish | redfish | password | host | host, bmc |
| `kubernetes` | kubernetes | https | api_token, password | host, url | k8s_cluster, k8s_namespace, k8s_workload, k8s_service, container, container_registry, host, operating_system, ip_address |
| `kvm_libvirt` | kvm_libvirt | ssh | password, ssh_key | host | hypervisor, host, vm, operating_system, ip_address |
| `ldap` | ldap | ldap, ldaps | password | host | user_account, service_account, host |
| `load_balancer` | load_balancer | https | password | host | load_balancer, listening_service, ip_address |
| `netflow` | netflow | netflow-v5, netflow-v9, ipfix, sflow-v5 | none | flow_source | ip_address |
| `nutanix_ahv` | nutanix_ahv | https | password | host, url | vm_cluster, hypervisor, host, bmc, vm, operating_system, ip_address, subnet, vlan, lun |
| `object_storage` | object_storage | s3 | api_token | url, host | object_bucket |
| `oracle_vm` | oracle_vm | https | password | host | vm_cluster, hypervisor, host, vm, operating_system, ip_address, lun, nas_share |
| `port_scan` | port_scan | tcp | none | host, cidr | host, unknown, ip_address, listening_service |
| `snmp` | snmp | snmp-v2c, snmp-v3 | snmp_v2c, snmp_v3 | host | network_device, interface, vlan, ip_address, unknown |
| `ssh_agentless` | ssh_agentless | ssh | password, ssh_key | host | host, vm, operating_system, interface, ip_address, listening_service, software, software_instance |
| `storage_ontap` | storage | https | password | host | storage_array, lun, nas_share, host, ip_address |
| `storage_pure` | storage | https | api_token | host | storage_array, lun, host |
| `vmware` | vmware | https | password | host | vm_cluster, hypervisor, vm, operating_system, ip_address, lun, nas_share |
| `vulnerability_feed` | vulnerability_feed | https | none, api_token | url | vulnerability |
| `wmi` | wmi | winrm | password | host | host, vm, operating_system, interface, ip_address, listening_service, software, software_instance |

25 families, contract version 0.1.0. Source of truth: the manifests; regenerate this file after adding a family.
