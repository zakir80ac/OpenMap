// T-448 REQ-QA-005 — relationship drift: an emitted relationship between two estate CIs the estate links with another
// type, or the same type the other way round, is counted; a link the estate also has, or does not model, is not.
package verify

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/openmap/openmap/tools/simulator/internal/estate"
)

const relDriftEstate = `{"tenantId":"t","collectorId":"vmware","cis":[` +
	`{"type":"host","identity":{"serialNumber":"S1","fqdn":"esx01.bank.local"},"name":"esx01"},` +
	`{"type":"hypervisor","identity":{"platform":"vmware","hostRef":"esx01.bank.local","moRef":"vc:host-1"},"name":"esx01"},` +
	`{"type":"vm","identity":{"instanceUuid":"u1","fqdn":"vm1.bank.local"},"name":"vm1"}],` +
	`"relationships":[` +
	`{"type":"runs_on","from":{"type":"hypervisor","identity":{"platform":"vmware","hostRef":"esx01.bank.local","moRef":"vc:host-1"}},"to":{"type":"host","identity":{"serialNumber":"S1","fqdn":"esx01.bank.local"}}},` +
	`{"type":"runs_on","from":{"type":"vm","identity":{"instanceUuid":"u1","fqdn":"vm1.bank.local"}},"to":{"type":"hypervisor","identity":{"platform":"vmware","hostRef":"esx01.bank.local","moRef":"vc:host-1"}}}]}` + "\n"

func TestRelationshipDrift(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "vmware.ndjson"), []byte(relDriftEstate), 0o600); err != nil {
		t.Fatal(err)
	}
	e, err := estate.Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	ix := NewEstateIndex(e, testRules(t))
	hv := ciRef{Type: "hypervisor", Identity: map[string]string{"platform": "vmware", "hostRef": "ESX01.bank.local", "moRef": "vc:host-1"}}
	res := &Result{Relationships: []observedRel{
		// The estate says runs_on; the collector says hosted_on: drift.
		{Type: "hosted_on", From: hv, To: ciRef{Type: "host", Identity: map[string]string{"fqdn": "esx01.bank.local"}}},
		// Same type and direction, the VM matched by its instance UUID alone: aligned.
		{Type: "runs_on", From: ciRef{Type: "vm", Identity: map[string]string{"instanceUuid": "U1", "hypervisorRef": "esx01"}}, To: hv},
		// A link the estate does not model: not drift.
		{Type: "member_of", From: hv, To: ciRef{Type: "vm_cluster", Identity: map[string]string{"platform": "vmware", "clusterId": "vc:domain-c1"}}},
	}}
	got := RelationshipDrift(res, e, ix)
	want := "hypervisor hosted_on host | estate: hypervisor runs_on host"
	if len(got) != 1 || got[want] != 1 {
		t.Fatalf("drift %v", got)
	}

	// The collector also reports the estate's own link: its other link between the pair is extra, not drift.
	res.Relationships = append(res.Relationships, observedRel{Type: "runs_on", From: hv, To: ciRef{Type: "host", Identity: map[string]string{"serialNumber": "S1"}}})
	if got := RelationshipDrift(res, e, ix); len(got) != 0 {
		t.Fatalf("extra link counted as drift: %v", got)
	}
}
