// T-410 REQ-QA-005 REQ-DISC-019 — the real netflow collector, listening on loopback for its capture window,
// receives the estate's conversations from the simulated exporter as NetFlow v5, NetFlow v9, IPFIX and
// sFlow v5 datagrams and reconstructs every communicates_with edge between the conversation addresses.
package netflow

import (
	"testing"

	"github.com/openmap/openmap/tools/simulator/internal/simtest"
)

func TestSimulatedFlowExport(t *testing.T) {
	reports := simtest.Run(t, Vendor{})
	if len(reports) != len(protocols) {
		t.Fatalf("expected one run per protocol, got %d", len(reports))
	}
}
