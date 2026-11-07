// T-392 REQ-QA-005 REQ-DISC-013 — the real hpe_oneview collector opens a session on the simulated OneView
// appliance (TLS verified against the simulated-mode CA), pages server-hardware past one page and rebuilds every
// estate HPE ProLiant host with its iLO, plus the seeded Synergy frame with its compute modules in their bays and
// its Virtual Connect modules; the session is closed afterwards.
package oneview

import (
	"strings"
	"testing"

	"github.com/openmap/openmap/tools/simulator/internal/simtest"
)

func TestSimulatedOneView(t *testing.T) {
	e := simtest.Estate(t)
	if n := len(build(e).servers); n <= 500 {
		t.Fatalf("the appliance must hold more servers than one collector page, has %d", n)
	}
	for _, r := range simtest.Run(t, Vendor{}) {
		if r.IdentityDriftCount != 0 {
			t.Errorf("OneView reports real iLO addresses and host identities; drift %d: %+v", r.IdentityDriftCount, r.IdentityDrift)
		}
		pages := 0
		for _, req := range r.RequestSample {
			if strings.HasPrefix(req, "GET /rest/server-hardware") {
				pages++
			}
		}
		if pages < 2 {
			t.Errorf("server-hardware was not paged: %v", r.RequestSample)
		}
	}
}
