# Vendor lab fixtures

Recorded outputs from real devices, one directory per collector family and device:

```
fixtures/vendor/<family>/<vendor>-<model>-<firmware>/
  manifest.json      family, vendor, model, firmware, capturedAt, capturedBy, files, redactions
  <capture files>    SNMP walks (snmpwalk -On), CLI transcripts, API responses (JSON), flow samples (pcap)
```

Rules (CLAUDE.md §8): fixtures are captured, never written by hand. Before check-in, redact serial numbers,
community strings, credentials and public addresses and list each redaction in the manifest. A collector
is not Done until it parses at least one recorded fixture for every vendor it claims.

Families expected: snmp, ssh_cli, wmi, winrm, ssh_agentless, vmware, hyperv, kvm_libvirt, nutanix_ahv,
oracle_vm, kubernetes, cloud_aws, cloud_azure, cloud_gcp, netflow, port_scan, ipmi_redfish, fc_fabric, nas,
object_storage, dns, dhcp, ldap, database, storage, pdu, agent, load_balancer, certificate,
vulnerability_feed, saas, os_patch.
