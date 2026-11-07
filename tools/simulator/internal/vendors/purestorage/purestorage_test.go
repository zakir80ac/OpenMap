// T-350 REQ-QA-005 REQ-DISC-014 — the real storage_pure collector, with TLS verified against the simulated-mode
// CA, reconstructs every Pure FlashArray in the estate: the array, each LUN it contains and each host it is
// presented to.
package purestorage

import (
	"testing"

	"github.com/openmap/openmap/tools/simulator/internal/simtest"
)

func TestSimulatedFlashArray(t *testing.T) {
	simtest.Run(t, Vendor{})
}
