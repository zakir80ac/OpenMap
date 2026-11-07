// T-370 REQ-QA-005 REQ-DISC-002 — the real wmi collector, over WinRM (Basic over HTTPS verified against the
// simulated-mode CA), inventories every Windows server in the estate: the host, its OS, adapters, primary address,
// listening services, installed agents and their software, with the relationships between them. Identity drift
// is logged by CI type; the host itself must merge with the estate's host.
package windows

import (
	"testing"

	"github.com/openmap/openmap/tools/simulator/internal/simtest"
)

func TestSimulatedWindowsServers(t *testing.T) {
	for _, r := range simtest.Run(t, Vendor{}) {
		byType := map[string]int{}
		for _, d := range r.IdentityDrift {
			byType[d.Type]++
			if d.Type == "host" {
				t.Errorf("host %s would not merge with the estate: estate %v, collector %v", d.Name, d.Estate, d.Collector)
			}
		}
		t.Logf("%s: identity drift %d (sample by type %v), %d WinRM requests", r.Run, r.IdentityDriftCount, byType, r.Requests)
	}
}
