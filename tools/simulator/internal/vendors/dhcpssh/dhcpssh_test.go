// T-364 REQ-QA-005 REQ-DISC-022 — the real dhcp collector in kea and isc modes, over SSH with the host key pinned,
// reads the configuration and lease database of the estate's DHCP server and reconstructs every scope, every active
// lease (the ISC journal's older released blocks superseded), the leased addresses and the leased_to links by MAC.
package dhcpssh

import (
	"testing"

	"github.com/openmap/openmap/tools/simulator/internal/simtest"
)

func TestSimulatedLinuxDHCPServers(t *testing.T) {
	simtest.Run(t, Vendor{})
}
