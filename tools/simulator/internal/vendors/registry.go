// REQ-QA-005 — every simulated vendor, in one list the CLI and the harness test iterate.
package vendors

import (
	"github.com/openmap/openmap/tools/simulator/internal/sim"
	"github.com/openmap/openmap/tools/simulator/internal/vendors/purestorage"
)

// All returns every simulator.
func All() []sim.Vendor {
	return []sim.Vendor{
		purestorage.Vendor{},
	}
}
