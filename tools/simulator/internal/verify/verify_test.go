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

	m := Compare(res, want, testRules(t), nil)
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

func testRules(t *testing.T) *IdentityRules {
	t.Helper()
	repo, err := RepoRoot()
	if err != nil {
		t.Fatal(err)
	}
	rules, err := LoadIdentityRules(repo)
	if err != nil {
		t.Fatal(err)
	}
	return rules
}

// T-448 REQ-QA-005 — drift follows reconciliation: a full tuple or any one globally unique key merges.
func TestMergesLikeTheReconciler(t *testing.T) {
	rules := testRules(t)
	cases := []struct {
		ciType string
		a, b   map[string]string
		want   bool
	}{
		{"host", map[string]string{"serialNumber": "S"}, map[string]string{"serialNumber": "s", "fqdn": "x"}, true},
		{"host", map[string]string{"serialNumber": "S"}, map[string]string{"fqdn": "x"}, false},
		{"lun", map[string]string{"arrayRef": "S", "wwn": "1"}, map[string]string{"arrayRef": "S", "wwn": "2"}, false},
		// address is globally unique: the VRF the collector cannot see does not split the address.
		{"ip_address", map[string]string{"address": "10.0.0.1", "vrfRef": "PROD"}, map[string]string{"address": "10.0.0.1", "vrfRef": "default"}, true},
		// interface keys are only unique within the device: a different deviceRef is a second interface.
		{"interface", map[string]string{"deviceRef": "S1", "ifIndex": "1", "name": "eth0"}, map[string]string{"deviceRef": "serial:S1", "ifIndex": "1", "name": "eth0"}, false},
		{"interface", map[string]string{"deviceRef": "serial:S1", "ifIndex": "1", "name": "Eth0"}, map[string]string{"deviceRef": "serial:s1", "ifIndex": "1", "name": "eth0"}, true},
	}
	for _, c := range cases {
		if got := rules.Merges(c.ciType, c.a, c.b, nil); got != c.want {
			t.Errorf("Merges(%s, %v, %v) = %v", c.ciType, c.a, c.b, got)
		}
	}
	if k := DriftKey("lun", cases[2].a, cases[2].b); k != "lun:wwn" {
		t.Errorf("drift key %q", k)
	}
}

// T-448 REQ-QA-005 — identities a collector derived from the dialled loopback address are read as the target's name.
func TestApplyAliases(t *testing.T) {
	res := &Result{Cis: []observedCi{
		{Type: "hypervisor", Identity: map[string]string{"moRef": "127.0.0.1:host-10", "hostRef": "esx01"}},
		{Type: "object_bucket", Identity: map[string]string{"endpoint": "127.0.0.1:9000", "name": "b"}},
		{Type: "dhcp_scope", Identity: map[string]string{"serverRef": "127.0.0.1", "cidr": "10.0.0.0/24"}},
	}}
	ApplyAliases(res, map[string]string{"127.0.0.1": "vc01.bank.local", "127.0.0.1:9000": "s3.bank.local"})
	if got := res.Cis[0].Identity["moRef"]; got != "vc01.bank.local:host-10" {
		t.Errorf("moRef %q", got)
	}
	if got := res.Cis[1].Identity["endpoint"]; got != "s3.bank.local" {
		t.Errorf("endpoint %q", got)
	}
	if got := res.Cis[2].Identity["serverRef"]; got != "vc01.bank.local" {
		t.Errorf("serverRef %q", got)
	}
	if got := res.Cis[0].Identity["hostRef"]; got != "esx01" {
		t.Errorf("hostRef %q", got)
	}
}
