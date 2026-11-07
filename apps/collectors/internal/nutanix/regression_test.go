// T-386 REQ-QA-005 REQ-DISC-008 — regressions the simulated Prism Central exposed: the Prism Central entity a
// v3 cluster list returns beside the AOS clusters is not emitted as a VM cluster, and a powered-off VM (no
// host_reference) carries no empty hypervisorRef identity value.
package nutanix

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

func TestPrismCentralEntityAndUnplacedVM(t *testing.T) {
	var inv Inventory
	clusters := `[{"metadata":{"uuid":"pc-1","kind":"cluster"},"status":{"name":"pc.corp.example","resources":{"config":{"service_list":["PRISM_CENTRAL"]}}}},
		{"metadata":{"uuid":"cl-1","kind":"cluster"},"status":{"name":"RYD-NTNX-01","resources":{"config":{"service_list":["AOS"]}}}}]`
	vms := `[{"metadata":{"uuid":"VM-OFF-1","kind":"vm"},"status":{"name":"off-01","cluster_reference":{"uuid":"cl-1"},"resources":{"power_state":"OFF"}}}]`
	if err := json.Unmarshal([]byte(clusters), &inv.Clusters); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(vms), &inv.VMs); err != nil {
		t.Fatal(err)
	}
	obs := Emit(&inv, contract.Target{Kind: "url", Value: "pc.corp.example"}, time.Now())
	n := 0
	for _, c := range obs.Cis {
		for k, v := range c.Identity {
			if v == "" {
				t.Errorf("%s %s has an empty identity value for %s", c.Type, c.Name, k)
			}
		}
		if c.Type == typeCluster {
			n++
			if c.Name != "RYD-NTNX-01" {
				t.Errorf("unexpected cluster %s", c.Name)
			}
		}
	}
	if n != 1 {
		t.Fatalf("expected one VM cluster, got %d", n)
	}
	for _, r := range obs.Relationships {
		if r.Type == relRunsOn {
			t.Fatalf("an unplaced VM runs on a hypervisor: %+v", r)
		}
	}
}
