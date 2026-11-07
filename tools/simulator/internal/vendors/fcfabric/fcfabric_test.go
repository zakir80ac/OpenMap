// T-362 REQ-QA-005 REQ-DISC-015 — the real fc_fabric collector, probing each estate FC switch over SSH (Brocade FOS
// with an ssh_key login, Cisco MDS NX-OS with a password, host keys pinned), detects the vendor and reconstructs
// the switch, its fabric (per VSAN on MDS), every zone of the effective configuration and every switch port.
package fcfabric

import (
	"testing"

	"github.com/openmap/openmap/tools/simulator/internal/simtest"
)

func TestSimulatedFCSwitches(t *testing.T) {
	simtest.Run(t, Vendor{})
}
