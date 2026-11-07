// T-366 REQ-DISC-003 REQ-QA-005 — regression found by the simulated-mode run against the synthetic estate: the
// operating_system identity family is "linux" for every distribution (the os-release ID moved to the id and
// distribution attributes), so the OS of a host seen by this collector and by the agent, libvirt or Kubernetes
// collectors reconciles to one CI instead of one per collector.
package sshlinux

import (
	"testing"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

func TestOSFamilyIsLinuxForEveryDistribution(t *testing.T) {
	for id, want := range map[string]string{"rhel": "linux", "ubuntu": "linux", "almalinux": "linux", "alpine": "linux", "": "linux", "FreeBSD": "freebsd"} {
		if got := OSFamily(id); got != want {
			t.Errorf("OSFamily(%q) = %q, want %q", id, got, want)
		}
	}
	obs := Emit(Assemble(Split(transcript)), contract.Target{Kind: "host", Value: "10.0.0.5"}, nil, time.Unix(0, 0).UTC())
	found := false
	for _, ci := range obs.Cis {
		if ci.Type != typeOS {
			continue
		}
		found = true
		if ci.Identity["family"] != "linux" || ci.Identity["version"] != "24.04" || ci.Attributes["distribution"] != "ubuntu" || ci.Attributes["id"] != "ubuntu" {
			t.Errorf("operating_system %+v %+v", ci.Identity, ci.Attributes)
		}
	}
	if !found {
		t.Fatal("no operating_system CI")
	}
}
