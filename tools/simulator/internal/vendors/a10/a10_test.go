// T-432 REQ-QA-005 REQ-DISC-018 — the real a10_thunder collector, with TLS verified against the simulated-mode
// CA, signs on to the generated Thunder for an aXAPI signature, reconstructs its virtual servers, VIPs,
// service groups and the estate API VMs behind them (by address and by FQDN), and logs off.
package a10

import (
	"strings"
	"testing"

	"github.com/openmap/openmap/tools/simulator/internal/simtest"
)

func TestSimulatedThunder(t *testing.T) {
	for _, r := range simtest.Run(t, Vendor{}) {
		signedOff := false
		for _, req := range r.RequestSample {
			signedOff = signedOff || strings.HasPrefix(req, "POST /axapi/v3/logoff 200")
		}
		if r.Requests <= len(r.RequestSample) && !signedOff {
			t.Errorf("%s: the collector did not log off: %v", r.Run, r.RequestSample)
		}
	}
}
