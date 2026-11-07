// T-390 REQ-QA-005 REQ-DISC-012 — the real ipmi_redfish collector, with TLS verified against the simulated-mode
// CA and Basic credentials, reads Dell iDRAC9, HPE iLO 5 and iLO 6 and Lenovo XClarity Controller 2 BMCs rendered
// from the estate, plus a seeded Cisco CIMC and a generic DMTF BMC: the bmc, the host it manages (identity
// aligned with the estate host) and the manages / contains relationships between them.
package redfish

import (
	"strings"
	"testing"

	"github.com/openmap/openmap/tools/simulator/internal/simtest"
)

func TestSimulatedRedfishBMCs(t *testing.T) {
	reports := simtest.Run(t, Vendor{})
	seen := map[string]bool{}
	for _, r := range reports {
		seen[strings.SplitN(r.Run, "/", 2)[0]] = true
	}
	for _, fl := range flavours {
		if !seen[fl.name] {
			t.Errorf("no run for the %s flavour", fl.name)
		}
	}
}
