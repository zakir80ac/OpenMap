// T-355 REQ-QA-005 REQ-CMDB-024 — the real warranty collector against simulated Dell TechDirect, Lenovo and Cisco
// SN2INFO/EoX APIs: OAuth and ClientID auth, Dell's 100-tag and Cisco's 75/20-serial batches with paging, an unknown
// serial skipped, and every estate server and switch answered with its warranty end, level and (Cisco) EoX dates.
package warranty

import (
	"testing"

	"github.com/openmap/openmap/tools/simulator/internal/simtest"
)

func TestSimulatedWarrantyLookups(t *testing.T) {
	reports := simtest.Run(t, Vendor{})
	if len(reports) != 3 {
		t.Fatalf("want dell, lenovo and cisco runs, got %d", len(reports))
	}
	for _, r := range reports {
		if r.IdentityDriftCount != 0 {
			t.Errorf("%s: %d serial identities would not merge with the estate's CIs", r.Run, r.IdentityDriftCount)
		}
	}
}
