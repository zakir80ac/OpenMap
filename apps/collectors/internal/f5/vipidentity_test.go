// T-435 REQ-QA-005 REQ-DISC-018 — regression found by the simulated BIG-IP: virtual servers sharing a port
// (two HTTPS VIPs on 443) must emit two listener identities, so neither the reconciler nor the depends_on
// edges to their pool members collapse them into one CI.
package f5

import (
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

func TestVirtualServersSharingAPortStayDistinct(t *testing.T) {
	inv := &Inventory{
		Device: device{Hostname: "ryd-lb-01.bank.local", ManagementIP: "10.0.0.14", ChassisID: "f5-FM1X44UW", SelfDevice: "true"},
		Virtuals: []virtual{
			{Name: "vs_cbs_443", FullPath: "/Common/vs_cbs_443", Destination: "/Common/10.4.3.254:443", IPProtocol: "tcp", Pool: "/Common/pool_cbs", Enabled: true},
			{Name: "vs_pos_443", FullPath: "/Common/vs_pos_443", Destination: "/Common/10.4.3.253:443", IPProtocol: "tcp", Pool: "/Common/pool_pos", Enabled: true},
		},
		Pools: []pool{{Name: "pool_cbs", FullPath: "/Common/pool_cbs"}, {Name: "pool_pos", FullPath: "/Common/pool_pos"}},
	}
	inv.Pools[0].Members.Items = []member{{Name: "web-ryd-cbs-01:443", Address: "10.4.0.36", State: "up"}}
	inv.Pools[1].Members.Items = []member{{Name: "web-ryd-pos-01:443", Address: "10.4.0.60", State: "up"}}
	obs := Emit(inv, contract.Target{Kind: "host", Value: "10.0.0.14"}, time.Now())
	keys := map[string]string{}
	for _, ci := range obs.Cis {
		if ci.Type != typeListener || ci.Identity["hostRef"] != "ryd-lb-01.bank.local" {
			continue
		}
		k := ci.Identity["hostRef"] + "|" + ci.Identity["protocol"] + "|" + ci.Identity["port"]
		if prev, dup := keys[k]; dup {
			t.Fatalf("%s and %s share the listener identity %s", prev, ci.Name, k)
		}
		keys[k] = ci.Name
	}
	if len(keys) != len(inv.Virtuals) {
		t.Fatalf("expected %d VIP listeners, got %v", len(inv.Virtuals), keys)
	}
	var targets []string
	for _, r := range obs.Relationships {
		if r.Type == relDependsOn {
			targets = append(targets, r.From.Identity["port"]+"->"+r.To.Identity["hostRef"])
		}
	}
	sort.Strings(targets)
	want := "/Common/vs_cbs_443:443->10.4.0.36,/Common/vs_pos_443:443->10.4.0.60"
	if strings.Join(targets, ",") != want {
		t.Fatalf("depends_on edges %v, want %s", targets, want)
	}
}
