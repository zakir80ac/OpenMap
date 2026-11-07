// T-424 REQ-QA-005 REQ-DISC-010 — the real cloud_alibaba collector signs RPC (ECS, RDS, SLB) and ROA (ACK) requests
// that the simulator verifies with HMAC-SHA1 (nonce replay and timestamp window enforced), pages every list with
// TLS verified against the simulated-mode CA, and reconstructs the generated account: VPC, VSwitches, ECS VMs with
// addresses and OS, all three RDS instances across pages, the SLB and the in-region ACK clusters.
package alibaba

import (
	"strings"
	"testing"

	"github.com/openmap/openmap/tools/simulator/internal/simtest"
)

func TestSimulatedAlibaba(t *testing.T) {
	for _, r := range simtest.Run(t, Vendor{}) {
		if r.EmittedByType["cloud_resource"] != 3 {
			t.Errorf("expected the VPC and two in-region ACK clusters, got %d cloud resources", r.EmittedByType["cloud_resource"])
		}
		paged := false
		for _, s := range r.RequestSample {
			paged = paged || strings.Contains(s, "PageNumber=2")
		}
		if !paged {
			t.Errorf("the collector never asked for a second page: %v", r.RequestSample)
		}
	}
}
