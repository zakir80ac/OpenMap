// T-359 REQ-QA-005 REQ-DISC-029 — every collector binary's manifest is valid against the collector contract's JSON
// Schema (packages/contracts/schemas/collector-manifest.schema.json): its id is the cmd directory name and matches the
// id pattern, and its family, credential types and target kinds are contract enum values, with the current contract
// version. The API drops a manifest that fails the contract, so an invalid one makes a collector invisible to
// discovery planning (found in simulated mode: snake_case ids and a "service_account" credential type).
package manifests

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"testing"

	"github.com/openmap/openmap/apps/collectors/internal/a10"
	"github.com/openmap/openmap/apps/collectors/internal/alibaba"
	"github.com/openmap/openmap/apps/collectors/internal/aws"
	"github.com/openmap/openmap/apps/collectors/internal/azure"
	"github.com/openmap/openmap/apps/collectors/internal/backup"
	"github.com/openmap/openmap/apps/collectors/internal/certificate"
	"github.com/openmap/openmap/apps/collectors/internal/citrixadc"
	"github.com/openmap/openmap/apps/collectors/internal/collector"
	"github.com/openmap/openmap/apps/collectors/internal/contract"
	"github.com/openmap/openmap/apps/collectors/internal/database"
	"github.com/openmap/openmap/apps/collectors/internal/dhcp"
	"github.com/openmap/openmap/apps/collectors/internal/directory"
	"github.com/openmap/openmap/apps/collectors/internal/dnszone"
	"github.com/openmap/openmap/apps/collectors/internal/docker"
	"github.com/openmap/openmap/apps/collectors/internal/f5"
	"github.com/openmap/openmap/apps/collectors/internal/fcfabric"
	"github.com/openmap/openmap/apps/collectors/internal/gcp"
	"github.com/openmap/openmap/apps/collectors/internal/haproxy"
	"github.com/openmap/openmap/apps/collectors/internal/hyperv"
	"github.com/openmap/openmap/apps/collectors/internal/kubernetes"
	"github.com/openmap/openmap/apps/collectors/internal/libvirt"
	"github.com/openmap/openmap/apps/collectors/internal/linkprobe"
	"github.com/openmap/openmap/apps/collectors/internal/nas"
	"github.com/openmap/openmap/apps/collectors/internal/netflow"
	"github.com/openmap/openmap/apps/collectors/internal/nginx"
	"github.com/openmap/openmap/apps/collectors/internal/nutanix"
	"github.com/openmap/openmap/apps/collectors/internal/objectstore"
	"github.com/openmap/openmap/apps/collectors/internal/oci"
	"github.com/openmap/openmap/apps/collectors/internal/oneview"
	"github.com/openmap/openmap/apps/collectors/internal/ontap"
	"github.com/openmap/openmap/apps/collectors/internal/ovirt"
	"github.com/openmap/openmap/apps/collectors/internal/portscan"
	"github.com/openmap/openmap/apps/collectors/internal/purestorage"
	"github.com/openmap/openmap/apps/collectors/internal/redfish"
	"github.com/openmap/openmap/apps/collectors/internal/saas"
	"github.com/openmap/openmap/apps/collectors/internal/snmp"
	"github.com/openmap/openmap/apps/collectors/internal/sshlinux"
	"github.com/openmap/openmap/apps/collectors/internal/ucs"
	"github.com/openmap/openmap/apps/collectors/internal/vmware"
	"github.com/openmap/openmap/apps/collectors/internal/vulnfeed"
	"github.com/openmap/openmap/apps/collectors/internal/warranty"
	"github.com/openmap/openmap/apps/collectors/internal/windows"
)

type schema struct {
	Properties struct {
		ID struct {
			Pattern string `json:"pattern"`
		} `json:"id"`
		Family struct {
			Enum []string `json:"enum"`
		} `json:"family"`
		CredentialTypes struct {
			Items struct {
				Enum []string `json:"enum"`
			} `json:"items"`
		} `json:"credentialTypes"`
		TargetKinds struct {
			Items struct {
				Enum []string `json:"enum"`
			} `json:"items"`
		} `json:"targetKinds"`
	} `json:"properties"`
	Version string `json:"version"`
}

func set(values []string) map[string]bool {
	out := map[string]bool{}
	for _, v := range values {
		out[v] = true
	}
	return out
}

func TestManifestsMatchTheContract(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "packages", "contracts", "schemas", "collector-manifest.schema.json"))
	if err != nil {
		t.Fatal(err)
	}
	var s schema
	if err := json.Unmarshal(raw, &s); err != nil {
		t.Fatal(err)
	}
	idPattern := regexp.MustCompile(s.Properties.ID.Pattern)
	families, creds, kinds := set(s.Properties.Family.Enum), set(s.Properties.CredentialTypes.Items.Enum), set(s.Properties.TargetKinds.Items.Enum)
	if len(families) == 0 || len(creds) == 0 || len(kinds) == 0 {
		t.Fatal("schema enums not found")
	}
	if s.Version != contract.Version {
		t.Fatalf("schema version %s, Go contract %s", s.Version, contract.Version)
	}
	all := []struct {
		cmd  string
		impl collector.Implementation
	}{
		{"a10_thunder", a10.Collector{}},
		{"backup", backup.Collector{}},
		{"certificate", certificate.Collector{}},
		{"cisco_ucs", ucs.Collector{}},
		{"citrix_adc", citrixadc.Collector{}},
		{"cloud_alibaba", alibaba.Collector{}},
		{"cloud_aws", aws.Collector{}},
		{"cloud_azure", azure.Collector{}},
		{"cloud_gcp", gcp.Collector{}},
		{"cloud_oci", oci.Collector{}},
		{"database", database.Collector{}},
		{"dhcp", dhcp.Collector{}},
		{"dns", dnszone.Collector{}},
		{"docker_engine", docker.Collector{}},
		{"fc_fabric", fcfabric.Collector{}},
		{"haproxy", haproxy.Collector{}},
		{"hpe_oneview", oneview.Collector{}},
		{"hyperv", hyperv.Collector{}},
		{"ipmi_redfish", redfish.Collector{}},
		{"kubernetes", kubernetes.Collector{}},
		{"kvm_libvirt", libvirt.Collector{}},
		{"ldap", directory.Collector{}},
		{"link_probe", linkprobe.Collector{}},
		{"load_balancer", f5.Collector{}},
		{"nas", nas.Collector{}},
		{"netflow", netflow.Collector{}},
		{"nginx", nginx.Collector{}},
		{"nutanix_ahv", nutanix.Collector{}},
		{"object_storage", objectstore.Collector{}},
		{"oracle_vm", ovirt.Collector{}},
		{"port_scan", portscan.Collector{}},
		{"saas", saas.Collector{}},
		{"snmp", snmp.Collector{}},
		{"ssh_agentless", sshlinux.Collector{}},
		{"storage_ontap", ontap.Collector{}},
		{"storage_pure", purestorage.Collector{}},
		{"vmware", vmware.Collector{}},
		{"vulnerability_feed", vulnfeed.Collector{}},
		{"warranty", warranty.Collector{}},
		{"wmi", windows.Collector{}},
	}
	for _, c := range all {
		m := c.impl.Manifest()
		if m.ID != c.cmd {
			t.Errorf("%s: manifest id %q differs from its cmd directory", c.cmd, m.ID)
		}
		if !idPattern.MatchString(m.ID) {
			t.Errorf("%s: id %q fails the contract pattern %s", c.cmd, m.ID, s.Properties.ID.Pattern)
		}
		if !families[m.Family] {
			t.Errorf("%s: family %q is not a contract family", c.cmd, m.Family)
		}
		for _, ct := range m.CredentialTypes {
			if !creds[ct] {
				t.Errorf("%s: credential type %q is not a contract credential type", c.cmd, ct)
			}
		}
		if len(m.TargetKinds) == 0 {
			t.Errorf("%s: no target kinds", c.cmd)
		}
		for _, k := range m.TargetKinds {
			if !kinds[k] {
				t.Errorf("%s: target kind %q is not a contract target kind", c.cmd, k)
			}
		}
		if m.ContractVersion != contract.Version {
			t.Errorf("%s: built against contract %s, current %s", c.cmd, m.ContractVersion, contract.Version)
		}
	}
}
