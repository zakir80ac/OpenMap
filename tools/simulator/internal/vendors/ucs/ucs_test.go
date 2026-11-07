// T-391 REQ-QA-005 REQ-DISC-013 — the real cisco_ucs collector logs in to the simulated UCS Manager XML API
// (aaaLogin cookie, TLS verified against the simulated-mode CA), resolves every class it reads and rebuilds the
// seeded domain: fabric interconnects, chassis, blades in their slots, blade and rack-unit hosts and their CIMCs.
package ucs

import (
	"strings"
	"testing"

	"github.com/openmap/openmap/tools/simulator/internal/simtest"
)

func TestSimulatedUCSManager(t *testing.T) {
	for _, r := range simtest.Run(t, Vendor{}) {
		posted := false
		for _, req := range r.RequestSample {
			posted = posted || strings.HasPrefix(req, "POST /nuova")
		}
		if !posted || r.Requests < len(knownClasses)+2 {
			t.Errorf("expected login, one configResolveClass per class and logout, got %d requests", r.Requests)
		}
	}
}
