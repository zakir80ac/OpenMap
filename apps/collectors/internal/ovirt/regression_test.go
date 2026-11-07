// T-387 REQ-QA-005 REQ-DISC-009 REQ-DISC-007 — regression the simulated ovirt-engine exposed: a VM that is
// down has no host element, and its identity must not carry an empty hypervisorRef value.
package ovirt

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

func TestDownVMHasNoEmptyIdentityValue(t *testing.T) {
	var inv Inventory
	if err := json.Unmarshal([]byte(`[{"id":"6f1c2a3b-0000-4000-8000-000000000001","name":"down-01","status":"down","cluster":{"id":"cl-1"}}]`), &inv.VMs); err != nil {
		t.Fatal(err)
	}
	obs := Emit(&inv, contract.Target{Kind: "host", Value: "engine.corp.example"}, defaultPlatform, time.Now())
	for _, c := range obs.Cis {
		for k, v := range c.Identity {
			if v == "" {
				t.Errorf("%s %s has an empty identity value for %s", c.Type, c.Name, k)
			}
		}
	}
	for _, r := range obs.Relationships {
		if r.Type == relRunsOn {
			t.Fatalf("a down VM runs on a hypervisor: %+v", r)
		}
	}
}
