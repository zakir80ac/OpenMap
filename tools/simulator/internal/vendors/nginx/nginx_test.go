// T-434 REQ-QA-005 REQ-DISC-018 — the real nginx collector reads every estate open-source NGINX through the
// Plus API probe and stub_status (over HTTPS with the simulated-mode CA pinned, or clear text), and the
// generated NGINX Plus gateway through its REST API: server zones, upstreams and the estate API VMs behind
// them.
package nginx

import (
	"testing"

	"github.com/openmap/openmap/tools/simulator/internal/simtest"
)

func TestSimulatedNGINX(t *testing.T) {
	simtest.Run(t, Vendor{})
}
