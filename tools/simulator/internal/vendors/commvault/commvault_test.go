// T-653 REQ-QA-005 REQ-INT-017 — the real backup collector against the simulated Commvault Command Center REST API,
// with TLS verified against the simulated-mode CA, reproduces every Commvault plan and storage policy of the estate and
// every server and database host they protect.
package commvault

import (
	"testing"

	"github.com/openmap/openmap/tools/simulator/internal/simtest"
)

func TestSimulatedCommvault(t *testing.T) {
	simtest.Run(t, Vendor{})
}
