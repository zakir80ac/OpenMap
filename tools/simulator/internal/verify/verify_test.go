// T-352 REQ-QA-005 — the harness comparison: CIs by type and name, relationships between emitted CIs or to
// reference-only CIs by identity, identity drift, and missing items reported.
package verify

import (
	"testing"

	"github.com/openmap/openmap/tools/simulator/internal/sim"
)

func TestCompare(t *testing.T) {
	res := &Result{
		Status: "success",
		Cis: []observedCi{
			{Type: "storage_array", Name: "A1", Identity: map[string]string{"serialNumber": "S1"}},
			{Type: "lun", Name: "L1", Identity: map[string]string{"arrayRef": "S1", "wwn": "naa.1"}},
		},
		Relationships: []observedRel{
			{Type: "contains", From: ciRef{Type: "storage_array", Identity: map[string]string{"serialNumber": "S1"}}, To: ciRef{Type: "lun", Identity: map[string]string{"arrayRef": "S1", "wwn": "naa.1"}}},
			{Type: "presented_to", From: ciRef{Type: "lun", Identity: map[string]string{"arrayRef": "S1", "wwn": "naa.1"}}, To: ciRef{Type: "host", Identity: map[string]string{"fqdn": "h1.bank.local"}}},
		},
	}
	var want sim.Expect
	want.CIs = append(want.CIs, sim.ExpectCI{Type: "storage_array", Name: "a1", Identity: map[string]string{"serialNumber": "S1"}})
	want.CIs = append(want.CIs, sim.ExpectCI{Type: "lun", Name: "L1", Identity: map[string]string{"arrayRef": "S1", "wwn": "6f00"}})
	want.CI("lun", "L2")
	want.Rel("contains", "storage_array", "A1", "lun", "L1")
	want.RelToRef("presented_to", "lun", "L1", "host", map[string]string{"fqdn": "H1.bank.local"})
	want.RelToRef("presented_to", "lun", "L1", "host", map[string]string{"fqdn": "h2.bank.local"})

	m := Compare(res, want)
	if m.MatchedCis != 2 || len(m.MissingCis) != 1 || m.MissingCis[0].Name != "L2" {
		t.Fatalf("CIs: matched %d missing %+v", m.MatchedCis, m.MissingCis)
	}
	if m.MatchedRels != 2 || len(m.MissingRels) != 1 || m.MissingRels[0].ToIdentity["fqdn"] != "h2.bank.local" {
		t.Fatalf("relationships: matched %d missing %+v", m.MatchedRels, m.MissingRels)
	}
	if len(m.IdentityDrift) != 1 || m.IdentityDrift[0].Name != "L1" {
		t.Fatalf("drift: %+v", m.IdentityDrift)
	}
	if m.ByType["lun"] != 1 || m.ByType["storage_array"] != 1 {
		t.Fatalf("by type: %+v", m.ByType)
	}
}

func TestAligned(t *testing.T) {
	cases := []struct {
		a, b map[string]string
		want bool
	}{
		{map[string]string{"serialNumber": "S"}, map[string]string{"serialNumber": "s", "fqdn": "x"}, true},
		{map[string]string{"serialNumber": "S"}, map[string]string{"fqdn": "x"}, false},
		{map[string]string{"arrayRef": "S", "wwn": "1"}, map[string]string{"arrayRef": "S", "wwn": "2"}, false},
	}
	for _, c := range cases {
		if got := aligned(c.a, c.b); got != c.want {
			t.Errorf("aligned(%v, %v) = %v", c.a, c.b, got)
		}
	}
}
