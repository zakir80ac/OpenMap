// T-422 REQ-QA-005 REQ-DISC-010 — the real cloud_gcp collector signs an RS256 service-account JWT that the
// simulated token endpoint verifies against the generated key, then reads Compute (aggregated lists with
// pageToken), Cloud SQL and GKE with TLS verified against the simulated-mode CA, and reconstructs the generated
// project: network, subnets, VMs with addresses and OS, load balancer, SQL instance and GKE cluster.
package gcp

import (
	"strings"
	"testing"

	"github.com/openmap/openmap/tools/simulator/internal/simtest"
)

func TestSimulatedGCP(t *testing.T) {
	for _, r := range simtest.Run(t, Vendor{}) {
		paged := false
		for _, s := range r.RequestSample {
			paged = paged || strings.Contains(s, "pageToken=")
		}
		if !paged {
			t.Errorf("the collector never followed a pageToken: %v", r.RequestSample)
		}
	}
}
