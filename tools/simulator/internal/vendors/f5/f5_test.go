// T-430 REQ-QA-005 REQ-DISC-018 — the real load_balancer (F5 BIG-IP) collector, with TLS verified against the
// simulated-mode CA and both token and Basic sign-on, reconstructs every estate BIG-IP: the appliance, its
// virtual servers and VIPs, and the pool members behind them on the estate VMs and hosts.
package f5

import (
	"testing"

	"github.com/openmap/openmap/tools/simulator/internal/simtest"
)

func TestSimulatedBigIP(t *testing.T) {
	simtest.Run(t, Vendor{})
}
