// T-449 REQ-DISC-003 — software has one shape on every collector: each software_instance is installed_on the host,
// is a member_of its software, and names it name@version, so the SSH, WMI and agent views of one package reconcile.
package sshlinux

import (
	"testing"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

func TestSoftwareShape(t *testing.T) {
	f := Assemble(Split(transcript))
	obs := Emit(f, contract.Target{Kind: "host", Value: "10.20.4.18"}, []byte(transcript), time.Now())
	installed, members := map[string]bool{}, map[string]bool{}
	for _, r := range obs.Relationships {
		if r.From.Type != typeInstall {
			continue
		}
		ref := r.From.Identity["softwareRef"]
		switch {
		case r.Type == relInstalled && (r.To.Type == "host" || r.To.Type == "vm"):
			installed[ref] = true
		case r.Type == relMemberOf && r.To.Type == typeSoftware:
			if ref != r.To.Identity["name"]+"@"+r.To.Identity["version"] {
				t.Errorf("softwareRef %q for software %v", ref, r.To.Identity)
			}
			members[ref] = true
		default:
			t.Errorf("software_instance linked by %s to %s", r.Type, r.To.Type)
		}
	}
	n := 0
	for _, c := range obs.Cis {
		if c.Type != typeInstall {
			continue
		}
		n++
		if ref := c.Identity["softwareRef"]; !installed[ref] || !members[ref] {
			t.Errorf("%s: installed_on %v member_of %v", ref, installed[ref], members[ref])
		}
	}
	if n == 0 {
		t.Fatal("no software instances emitted")
	}
}
