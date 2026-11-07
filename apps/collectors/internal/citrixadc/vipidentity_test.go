// T-436 REQ-QA-005 REQ-DISC-018 — regression found by the simulated NetScaler: lbvservers sharing a port (two
// SSL VIPs on 443) and a content-switching vserver on the same port must emit distinct listener identities,
// and the content-switching edge must reach each targeted lbvserver rather than one merged CI.
package citrixadc

import (
	"testing"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

func TestVserversSharingAPortStayDistinct(t *testing.T) {
	inv := &Inventory{
		Hostname: "ryd-adc-01", Serial: "SIMNS0001", NSIPs: []string{"10.0.0.250"},
		Virtuals: []LBVserver{
			{Name: "lb_cbs_api", Address: "10.4.3.240", Port: 443, ServiceType: "SSL", State: "UP"},
			{Name: "lb_pos_api", Address: "10.4.3.239", Port: 443, ServiceType: "SSL", State: "UP"},
		},
		Members:    map[string][]Member{},
		CSVirtuals: []CSVserver{{Name: "cs_api", Address: "10.4.3.238", Port: 443, ServiceType: "SSL", State: "UP"}},
		CSTargets:  map[string][]string{"cs_api": {"lb_cbs_api", "lb_pos_api"}},
	}
	obs := Emit(inv, contract.Target{Kind: "host", Value: "10.0.0.250"}, time.Now())
	keys := map[string]string{}
	for _, ci := range obs.Cis {
		if ci.Type != typeListener {
			continue
		}
		k := ci.Identity["hostRef"] + "|" + ci.Identity["protocol"] + "|" + ci.Identity["port"]
		if prev, dup := keys[k]; dup {
			t.Fatalf("%s and %s share the listener identity %s", prev, ci.Name, k)
		}
		keys[k] = ci.Name
	}
	if len(keys) != len(inv.Virtuals)+len(inv.CSVirtuals) {
		t.Fatalf("expected %d vserver listeners, got %v", len(inv.Virtuals)+len(inv.CSVirtuals), keys)
	}
	reached := map[string]bool{}
	for _, r := range obs.Relationships {
		if r.Type == relDependsOn && r.From.Identity["port"] == csPrefix+"cs_api:443" {
			reached[r.To.Identity["port"]] = true
		}
	}
	if !reached["lb_cbs_api:443"] || !reached["lb_pos_api:443"] || len(reached) != len(inv.Virtuals) {
		t.Fatalf("content switching reached %v", reached)
	}
}
