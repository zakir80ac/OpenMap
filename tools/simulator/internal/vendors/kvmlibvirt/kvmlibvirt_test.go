// T-361 REQ-QA-005 REQ-DISC-007 — the real kvm_libvirt collector, over SSH with the host key pinned, reconstructs
// each seeded libvirt host: the physical host, its KVM hypervisor, every domain (running with the guest agent,
// running with a dnsmasq lease only, shut off), guest operating systems and guest addresses.
package kvmlibvirt

import (
	"testing"

	"github.com/openmap/openmap/tools/simulator/internal/simtest"
)

func TestSimulatedLibvirtHosts(t *testing.T) {
	simtest.Run(t, Vendor{})
}
