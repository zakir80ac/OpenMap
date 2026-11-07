// T-412 REQ-QA-005 REQ-DISC-021 — the real dns collector transfers the estate's zones by AXFR from simulated
// BIND (TSIG hmac-sha512), Windows DNS (unsigned) and Infoblox NIOS (TSIG hmac-sha256) servers and emits every
// estate zone and record, the A records' addresses and the contains / resolves_to relationships.
package dnszone

import (
	"testing"

	"github.com/openmap/openmap/tools/simulator/internal/simtest"
)

func TestSimulatedAuthoritativeDNS(t *testing.T) {
	simtest.Run(t, Vendor{})
}
