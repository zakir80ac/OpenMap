// T-433 REQ-QA-005 REQ-DISC-018 — the real haproxy collector reads the generated HAProxy pair's statistics
// CSV: over HTTPS with stats auth and the simulated-mode CA pinned (show-legends, so the estate Patroni and
// infrastructure members become listeners with their addresses) and over plain HTTP on the default page
// (pools and frontends only), with each listen section's frontend tied to its backend.
package haproxy

import (
	"testing"

	"github.com/openmap/openmap/tools/simulator/internal/simtest"
)

func TestSimulatedHAProxy(t *testing.T) {
	simtest.Run(t, Vendor{})
}
