// T-455 REQ-DISC-018 REQ-CORE-013 — an upstream member is the TCP listener on its host, keyed as the host's own collector
// and every other load balancer collector key it, so reconciliation merges the two observations (ADR-045). Simulated
// mode found the members keyed by "http" instead, one listener per observer.
package nginx

import (
	"context"
	"testing"

	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

func TestUpstreamMembersAreTCPListeners(t *testing.T) {
	srv := plusServer(t)
	defer srv.Close()
	obs, err := Collector{}.Collect(context.Background(), contract.Target{Kind: "url", Value: srv.URL}, nil, map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	members := 0
	for _, ci := range obs.Cis {
		if ci.Type != typeListener || ci.Attributes["poolMemberState"] == nil {
			continue
		}
		members++
		if ci.Identity["protocol"] != "tcp" || ci.Attributes["protocol"] != "tcp" || ci.Attributes["applicationProtocol"] != "http" {
			t.Errorf("member %s: identity %v, attributes protocol %v / %v", ci.Name, ci.Identity, ci.Attributes["protocol"], ci.Attributes["applicationProtocol"])
		}
	}
	if members != 3 {
		t.Fatalf("members = %d", members)
	}
	for _, r := range obs.Relationships {
		if r.Type == relDependsOn && r.To.Identity["port"] == "8080" && r.To.Identity["protocol"] != "tcp" {
			t.Errorf("depends_on names the member as %v", r.To.Identity)
		}
	}
}
