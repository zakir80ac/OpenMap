// T-653 REQ-QA-005 REQ-INT-017 — the real backup collector against the simulated Veeam Backup & Replication REST API,
// with TLS verified against the simulated-mode CA, reproduces every Veeam job of the estate and every VM it protects.
package veeam

import (
	"testing"

	"github.com/openmap/openmap/tools/simulator/internal/simtest"
)

func TestSimulatedVeeam(t *testing.T) {
	simtest.Run(t, Vendor{})
}
