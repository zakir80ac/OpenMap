// T-449 REQ-DISC-002 — software has one shape on every collector: each software_instance is installed_on the host,
// is a member_of its software, and names it name@version, so the SSH, WMI and agent views of one package reconcile.
package windows

import (
	"testing"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

func TestSoftwareShape(t *testing.T) {
	inv, err := Parse("Some banner line\n" + physical)
	if err != nil {
		t.Fatal(err)
	}
	obs := Emit(inv, contract.Target{Kind: "host", Value: "10.120.5.40"}, []byte(physical), time.Now())
	installed, members := map[string]bool{}, map[string]bool{}
	for _, r := range obs.Relationships {
		if r.From.Type != typeInstall {
			continue
		}
		ref := r.From.Identity["softwareRef"]
		switch {
		case r.Type == relInstalledOn && r.To.Type == typeHost:
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
