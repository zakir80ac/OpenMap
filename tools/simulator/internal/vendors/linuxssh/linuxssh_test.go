// T-360 REQ-QA-005 REQ-DISC-003 — the real ssh_agentless collector, over SSH with the host key pinned (password and
// ssh_key logins), reconstructs each sampled estate Linux host and AHV guest: the system with its estate identity,
// its operating system, interfaces, addresses, listening services and OS packages.
package linuxssh

import (
	"testing"

	"github.com/openmap/openmap/tools/simulator/internal/simtest"
)

func TestSimulatedLinuxHosts(t *testing.T) {
	simtest.Run(t, Vendor{})
}
