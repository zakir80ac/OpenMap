// T-443 REQ-QA-005 REQ-CMDB-022 — regressions the simulated SaaS tenants exposed: Google Workspace groups are
// paged by nextPageToken (only the first 200 were counted), and the vendor CI is the company the vendor
// catalogue knows ("Microsoft", not the adapter key "microsoft365"), with the adapter kept as the provider
// attribute, so the SaaS vendor merges with the supplier record instead of creating a second vendor; and a
// Salesforce user licence reported Disabled (lapsed) is degraded, not left without health.
package saas

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

func TestGroupsPagedAndVendorIsCompany(t *testing.T) {
	const pages = 3
	key, _ := rsa.GenerateKey(rand.Reader, 2048)
	der, _ := x509.MarshalPKCS8PrivateKey(key)
	mux := http.NewServeMux()
	tokenEndpoint(t, mux, grantJWTBearer, nil)
	mux.HandleFunc("/admin/directory/v1/customers/my_customer", authed(`{"id":"C01abc","customerDomain":"bank.local","postalAddress":{"organizationName":"Bank"}}`))
	mux.HandleFunc("/admin/directory/v1/users", authed(`{"users":[{"suspended":false}]}`))
	mux.HandleFunc("/admin/directory/v1/groups", func(w http.ResponseWriter, r *http.Request) {
		n, _ := strconv.Atoi(strings.TrimPrefix(r.URL.Query().Get("pageToken"), "g"))
		groups := strings.TrimSuffix(strings.Repeat(`{},`, googleGroupsPage), ",")
		next := ""
		if n+1 < pages {
			next = `,"nextPageToken":"g` + strconv.Itoa(n+1) + `"`
		}
		authed(`{"groups":[`+groups+`]`+next+`}`)(w, r)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	sa := &contract.Credential{Type: "service_account", Fields: map[string]string{credEmail: "svc@proj.iam.gserviceaccount.com", credKey: string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})), credAdmin: "admin@bank.local"}}
	obs, err := Collector{}.Collect(context.Background(), contract.Target{Kind: "account", Value: "bank.local"}, sa, map[string]any{optionVendor: vendorGoogle, optionAPI: srv.URL, optionToken: srv.URL + "/token", optionScope: "directory.readonly"})
	if err != nil {
		t.Fatal(err)
	}
	_, byName := summarise(obsLike{obs.Cis, obs.Relationships})
	tenant := byName["Bank"]
	if tenant.Attributes["groups"] != int64(pages*googleGroupsPage) {
		t.Fatalf("groups must be counted across pages: %v", tenant.Attributes["groups"])
	}
	vendor, ok := byName["Google"]
	if !ok || vendor.Type != typeVendor || vendor.Identity["name"] != "Google" {
		t.Fatalf("vendor CI must be the company: %+v", byName)
	}
	if tenant.Identity["vendor"] != "Google" || tenant.Attributes["provider"] != vendorGoogle {
		t.Fatalf("tenant identity must carry the company, the attributes the provider: %v %v", tenant.Identity, tenant.Attributes)
	}
	for _, r := range obs.Relationships {
		if r.Type == relMemberOf && r.To.Identity["name"] != "Google" {
			t.Fatalf("member_of must point at the company vendor: %+v", r.To)
		}
	}
}

func TestDisabledLicenceDegraded(t *testing.T) {
	obs := Emit(&Tenant{Vendor: vendorSalesforce, TenantID: "00D", Products: []Product{{Name: "Service Cloud", SKU: "Service Cloud", SeatsTotal: 10, SeatsAssigned: 9, Status: "disabled"}}}, time.Now())
	for _, c := range obs.Cis {
		if c.Type == typeApplication && c.Attributes["health"] != "degraded" {
			t.Fatalf("a disabled licence must be degraded: %v", c.Attributes)
		}
	}
}
