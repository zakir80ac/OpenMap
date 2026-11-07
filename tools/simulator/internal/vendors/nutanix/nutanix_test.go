// T-381 REQ-QA-005 REQ-DISC-008 — the real nutanix_ahv collector, with TLS verified against the simulated-mode
// CA, reconstructs every estate AHV cluster through one Prism Central: clusters, hosts with their BMCs and
// hypervisors, VMs with addresses, subnets, VLANs and storage containers.
package nutanix

import (
	"testing"

	"github.com/openmap/openmap/tools/simulator/internal/simtest"
)

func TestSimulatedPrismCentral(t *testing.T) {
	for _, r := range simtest.Run(t, Vendor{}) {
		if r.EmittedByType["vm_cluster"] != len(build(simtest.Estate(t)).clusters) {
			t.Errorf("the Prism Central entity was emitted as a VM cluster: %d vm_cluster CIs", r.EmittedByType["vm_cluster"])
		}
	}
}
