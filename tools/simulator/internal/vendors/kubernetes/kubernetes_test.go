// T-383 REQ-QA-005 REQ-DISC-011 — the real kubernetes collector, with TLS verified against the simulated-mode CA
// and a bearer token, reconstructs the estate's Kubernetes cluster and a generated OpenShift cluster:
// namespaces, nodes, workloads, services and their selector dependencies, running containers and registries.
package kubernetes

import (
	"testing"

	"github.com/openmap/openmap/tools/simulator/internal/simtest"
)

func TestSimulatedAPIServers(t *testing.T) {
	reports := simtest.Run(t, Vendor{})
	names := map[string]bool{}
	for _, r := range reports {
		names[r.Run] = true
	}
	if !names[ocpName] || len(reports) < 2 {
		t.Fatalf("expected an estate cluster run and the OpenShift run, got %v", names)
	}
}
