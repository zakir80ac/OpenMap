// T-363 REQ-QA-005 REQ-DISC-016 — the real nas collector in linux mode, over SSH with the host key pinned, reads
// testparm and exportfs on each simulated estate file server and emits every Samba share (online and offline) and
// every NFS export, including wrapped long export paths, contained by the serving host.
package naslinux

import (
	"testing"

	"github.com/openmap/openmap/tools/simulator/internal/simtest"
)

func TestSimulatedLinuxFileServers(t *testing.T) {
	simtest.Run(t, Vendor{})
}
