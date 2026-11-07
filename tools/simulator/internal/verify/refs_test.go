// T-454 REQ-QA-005 REQ-CORE-013 — the harness applies ADR-045 as reconciliation does: a `*Ref` value resolves to the
// estate CI it names before tuples compare, a scoped global key needs its issuer's scope, and no two CIs of the
// synthetic estate merge with each other.
package verify

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/openmap/openmap/tools/simulator/internal/estate"
)

const refsEstate = `{"tenantId":"t","collectorId":"nutanix_ahv","cis":[` +
	`{"type":"vm","identity":{"instanceUuid":"dc7a-1","hypervisorRef":"ahv-01.bank.local","fqdn":"api-01.bank.local"},"name":"api-01","attributes":{"ipAddress":"10.36.0.10"}},` +
	`{"type":"host","identity":{"serialNumber":"S1"},"name":"web-01","attributes":{"primaryIp":"10.0.0.5"}},` +
	`{"type":"host","identity":{"serialNumber":"S2"},"name":"web-02","attributes":{"primaryIp":"10.0.0.5"}},` +
	`{"type":"listening_service","identity":{"hostRef":"dc7a-1","protocol":"tcp","port":"8443"},"name":"api-01 tcp/8443"}],"relationships":[]}` + "\n"

func TestMergesResolvesRefsAndScopesGlobalKeys(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "agent.ndjson"), []byte(refsEstate), 0o600); err != nil {
		t.Fatal(err)
	}
	e, err := estate.Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	rules := testRules(t)
	ix := NewEstateIndex(e, rules)
	listener := map[string]string{"hostRef": "dc7a-1", "protocol": "tcp", "port": "8443"}
	cases := []struct {
		name string
		b    map[string]string
		want bool
	}{
		{"load balancer names the member by IP", map[string]string{"hostRef": "10.36.0.10", "protocol": "tcp", "port": "8443"}, true},
		{"F5 names it by FQDN", map[string]string{"hostRef": "API-01.bank.local", "protocol": "tcp", "port": "8443"}, true},
		{"another port", map[string]string{"hostRef": "10.36.0.10", "protocol": "tcp", "port": "443"}, false},
		{"an address two hosts share names neither", map[string]string{"hostRef": "10.0.0.5", "protocol": "tcp", "port": "8443"}, false},
	}
	for _, c := range cases {
		if got := rules.Merges("listening_service", listener, c.b, ix.Refs); got != c.want {
			t.Errorf("%s: Merges = %v", c.name, got)
		}
	}
	if rules.Merges("listening_service", listener, cases[0].b, nil) {
		t.Error("without ref resolution the IP spelling must not merge")
	}
	if got := ix.Lookup("listening_service", cases[0].b); got == nil || got.Name != "api-01 tcp/8443" {
		t.Errorf("lookup by IP spelling = %v", got)
	}
	now := map[string]string{"vendor": "ServiceNow", "tenantId": "horizonbank"}
	if rules.Merges("saas_tenant", now, map[string]string{"vendor": "Workday", "tenantId": "horizonbank"}, ix.Refs) {
		t.Error("tenants of two vendors with one id must not merge")
	}
	if !rules.Merges("saas_tenant", now, map[string]string{"vendor": "servicenow", "tenantId": "HorizonBank"}, ix.Refs) {
		t.Error("one tenant observed twice must merge")
	}
	if rules.Merges("cloud_resource", map[string]string{"provider": "gcp", "resourceId": "42"}, map[string]string{"provider": "alibaba", "resourceId": "42"}, ix.Refs) {
		t.Error("resource ids of two providers must not merge")
	}
}

// The checked-in synthetic estate holds every CI once: no two of its CIs share a lookup key under the reconciler's rules.
func TestSynthEstateHasNoSelfMerges(t *testing.T) {
	repo, err := RepoRoot()
	if err != nil {
		t.Fatal(err)
	}
	e, err := estate.Load(filepath.Join(repo, "packages", "testing", "fixtures", "synth-small"))
	if err != nil {
		t.Fatal(err)
	}
	ix := NewEstateIndex(e, testRules(t))
	if c := ix.Collisions(e); len(c) > 0 {
		n := len(c)
		if n > 10 {
			c = c[:10]
		}
		t.Fatalf("%d estate CIs merge with another: %v", n, c)
	}
}
