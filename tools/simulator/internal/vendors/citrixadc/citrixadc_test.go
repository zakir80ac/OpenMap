// T-431 REQ-QA-005 REQ-DISC-018 — the real citrix_adc collector, with TLS verified against the simulated-mode
// CA and NITRO header auth, reconstructs the generated NetScaler HA pair: appliance facts, SSL lbvservers and
// their VIPs, service-group and directly bound members on the estate API VMs, and the content-switching
// vserver's edges to every lbvserver.
package citrixadc

import (
	"testing"

	"github.com/openmap/openmap/tools/simulator/internal/simtest"
)

func TestSimulatedNetScaler(t *testing.T) {
	simtest.Run(t, Vendor{})
}
