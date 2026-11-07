// T-423 REQ-QA-005 REQ-DISC-010 — the real cloud_oci collector signs every request with its API key (OCI HTTP
// Signature, verified server-side with the key's fingerprint), follows opc-next-page across the generated
// tenancy's compartments with TLS verified against the simulated-mode CA, and reconstructs compartments, VCN,
// subnets, VMs (VCN-DNS fqdn, addresses, OS), DB system, OKE cluster and load balancer.
package oci

import (
	"strings"
	"testing"

	"github.com/openmap/openmap/tools/simulator/internal/simtest"
)

func TestSimulatedOCI(t *testing.T) {
	for _, r := range simtest.Run(t, Vendor{}) {
		if r.IdentityDriftCount != 0 {
			t.Errorf("collector VM identities do not merge with the generated ones: %+v", r.IdentityDrift)
		}
		paged := false
		for _, s := range r.RequestSample {
			paged = paged || strings.Contains(s, "page=")
		}
		if !paged {
			t.Errorf("no paged request among the first %d: %v", len(r.RequestSample), r.RequestSample)
		}
	}
}
