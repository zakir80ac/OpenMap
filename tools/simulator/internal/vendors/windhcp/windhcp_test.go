// T-373 REQ-QA-005 REQ-DISC-022 — the real dhcp collector in Windows mode, over WinRM (Basic over HTTPS verified
// against the simulated-mode CA), reads every estate DHCP scope and lease from the simulated Windows DHCP Server:
// scopes under the server's DNS name (so they merge with the estate's scopes), their subnets, the leases they
// contain, each lease's address and the host its MAC belongs to.
package windhcp

import (
	"testing"

	"github.com/openmap/openmap/tools/simulator/internal/simtest"
)

func TestSimulatedWindowsDhcp(t *testing.T) {
	for _, r := range simtest.Run(t, Vendor{}) {
		for _, d := range r.IdentityDrift {
			if d.Type == "dhcp_scope" || d.Type == "dhcp_lease" {
				t.Errorf("%s %s would not merge with the estate: estate %v, collector %v", d.Type, d.Name, d.Estate, d.Collector)
			}
		}
		t.Logf("%s: identity drift %d, %d WinRM requests", r.Run, r.IdentityDriftCount, r.Requests)
	}
}
