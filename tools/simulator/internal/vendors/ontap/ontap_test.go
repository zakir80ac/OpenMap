// T-393 REQ-QA-005 REQ-DISC-014 REQ-DISC-016 — the real storage_ontap collector reads the simulated ONTAP cluster
// over Basic auth and TLS verified against the simulated-mode CA, follows every _links.next page and rebuilds the
// seeded HA pair: the array, its NFS and SMB shares (root, dp and hidden admin shares left out), its LUNs as NetApp
// NAA WWNs, the LUN maps as presented_to the estate's VMware hosts, and the data LIF addresses.
package ontap

import (
	"testing"

	"github.com/openmap/openmap/tools/simulator/internal/simtest"
)

func TestSimulatedONTAP(t *testing.T) {
	e := simtest.Estate(t)
	if len(esxTargets(e)) == 0 {
		t.Fatal("the estate has no VMware hypervisor hosts to present LUNs to")
	}
	c := build(e)
	pagesNeeded := 1 // /api/cluster
	for _, coll := range collections {
		pagesNeeded += (len(c.records[coll]) + returnTimeoutRecords - 1) / returnTimeoutRecords
		if len(c.records[coll]) == 0 {
			pagesNeeded++
		}
	}
	for _, r := range simtest.Run(t, Vendor{}) {
		if r.Requests != pagesNeeded {
			t.Errorf("expected %d requests (every page of every collection once), got %d", pagesNeeded, r.Requests)
		}
	}
}
