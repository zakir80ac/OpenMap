// T-372 REQ-QA-005 REQ-DISC-016 — the real nas collector in Windows mode, over WinRM (Basic over HTTPS verified
// against the simulated-mode CA), lists the SMB shares of every Windows file server in the estate as nas_share CIs
// named and contained by the server's DNS name (not the address the job targeted), with no identity drift.
package winsmb

import (
	"testing"

	"github.com/openmap/openmap/tools/simulator/internal/simtest"
)

func TestSimulatedWindowsFileServers(t *testing.T) {
	for _, r := range simtest.Run(t, Vendor{}) {
		if r.IdentityDriftCount != 0 {
			t.Errorf("%s: %d shares would not merge: %+v", r.Run, r.IdentityDriftCount, r.IdentityDrift)
		}
	}
}
