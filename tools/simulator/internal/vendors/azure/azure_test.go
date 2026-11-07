// T-421 REQ-QA-005 REQ-DISC-010 — the real cloud_azure collector obtains a client-credentials token from the
// simulated Entra ID endpoint, reads ARM with nextLink paging and TLS verified against the simulated-mode CA, and
// reconstructs the estate's Azure subscription and every resource in it, with the VM's NIC address, subnet and OS.
package azure

import (
	"testing"

	"github.com/openmap/openmap/tools/simulator/internal/simtest"
)

func TestSimulatedAzure(t *testing.T) {
	for _, r := range simtest.Run(t, Vendor{}) {
		for _, d := range r.IdentityDrift {
			t.Logf("identity drift %s %q: estate %v, collector %v", d.Type, d.Name, d.Estate, d.Collector)
		}
		t.Logf("%d requests: %v", r.Requests, r.RequestSample)
	}
}
