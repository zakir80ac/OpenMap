// T-371 REQ-QA-005 REQ-DISC-006 — the real hyperv collector, over WinRM (Basic over HTTPS verified against the
// simulated-mode CA), reconstructs every Hyper-V host in the estate: the host and its OS, the hypervisor, the
// failover cluster, every VM it runs, the guest OS and address of each running VM, with their relationships.
// Identity drift is logged by CI type; VMs must merge with the estate's VMs.
package hyperv

import (
	"testing"

	"github.com/openmap/openmap/tools/simulator/internal/simtest"
)

func TestSimulatedHyperV(t *testing.T) {
	for _, r := range simtest.Run(t, Vendor{}) {
		byType := map[string]int{}
		for _, d := range r.IdentityDrift {
			byType[d.Type]++
			if d.Type == "vm" || d.Type == "host" {
				t.Errorf("%s %s would not merge with the estate: estate %v, collector %v", d.Type, d.Name, d.Estate, d.Collector)
			}
		}
		t.Logf("%s: identity drift %d (sample by type %v), %d WinRM requests", r.Run, r.IdentityDriftCount, byType, r.Requests)
	}
}
