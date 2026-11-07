// T-380 REQ-QA-005 REQ-DISC-005 — the real vmware collector, with TLS verified against the simulated-mode CA,
// reconstructs every estate vCenter: a 7.0+ `/api` vCenter and a 6.x `/rest`-only vCenter, each with its
// clusters, hypervisors, VMs, datastores, guest operating systems and guest addresses.
package vmware

import (
	"testing"

	"github.com/openmap/openmap/tools/simulator/internal/simtest"
)

func TestSimulatedVcenter(t *testing.T) {
	reports := simtest.Run(t, Vendor{})
	if len(reports) < 2 {
		t.Fatalf("expected a modern and a legacy vCenter run, got %d", len(reports))
	}
}
