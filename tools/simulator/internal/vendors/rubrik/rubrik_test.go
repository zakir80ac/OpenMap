// T-653 REQ-QA-005 REQ-INT-017 — the real backup collector against the simulated Rubrik CDM REST API, with TLS
// verified against the simulated-mode CA, reproduces every SLA domain of the estate and every VM and fileset host it
// protects, and skips the VMs no domain protects.
package rubrik

import (
	"testing"

	"github.com/openmap/openmap/tools/simulator/internal/simtest"
)

func TestSimulatedRubrik(t *testing.T) {
	simtest.Run(t, Vendor{})
}
