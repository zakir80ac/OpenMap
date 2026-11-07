// T-382 REQ-QA-005 REQ-DISC-009 REQ-DISC-007 — the real oracle_vm collector, with TLS verified against the
// simulated-mode CA, reconstructs a generated Oracle Linux Virtualization Manager engine and a generated oVirt
// engine: clusters, KVM hosts and hypervisors, VMs (running and down), guest operating systems, guest
// addresses and NFS / iSCSI storage domains.
package ovirt

import (
	"testing"

	"github.com/openmap/openmap/tools/simulator/internal/simtest"
)

func TestSimulatedOvirtEngines(t *testing.T) {
	reports := simtest.Run(t, Vendor{})
	if len(reports) != len(engines) {
		t.Fatalf("expected one run per engine, got %d", len(reports))
	}
}
