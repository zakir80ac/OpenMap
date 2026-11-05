// T-075 REQ-CMDB-022 — every SaaS adapter against an httptest stand-in for the vendor: Microsoft Graph (client
// credentials, ConsistencyLevel counts, SKUs), Google Workspace Directory (delegated service-account JWT, paged
// users), Salesforce (SOQL organization, licences, counts), ServiceNow (properties, stats, licence details) and
// Workday (workers total); then the emitted vendor, tenant and licensed applications.
package saas

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

func tokenEndpoint(t *testing.T, mux *http.ServeMux, expectGrant string, onForm func(form map[string][]string)) {
	t.Helper()
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		if r.Form.Get("grant_type") != expectGrant {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		if onForm != nil {
			onForm(r.Form)
		}
		_, _ = w.Write([]byte(`{"access_token":"tok-1","token_type":"Bearer","expires_in":3599}`))
	})
}

func authed(body string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer tok-1" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(body))
	}
}

func summarise(obs obsLike) (map[string]int, map[string]contract.ObservedCi) {
	types := map[string]int{}
	byName := map[string]contract.ObservedCi{}
	for _, ci := range obs.Cis {
		types[ci.Type]++
		byName[ci.Name] = ci
	}
	return types, byName
}

type obsLike = struct {
	Cis           []contract.ObservedCi
	Relationships []contract.ObservedRelationship
}

func TestMicrosoft365(t *testing.T) {
	mux := http.NewServeMux()
	var seenScope string
	tokenEndpoint(t, mux, "client_credentials", func(form map[string][]string) { seenScope = form["scope"][0] })
	mux.HandleFunc("/v1.0/organization", authed(`{"value":[{"id":"72f988bf-86f1-41af-91ab-2d7cd011db47","displayName":"Bank","tenantType":"AAD","verifiedDomains":[{"name":"bank.onmicrosoft.com","isDefault":false},{"name":"bank.local","isDefault":true}]}]}`))
	mux.HandleFunc("/v1.0/directory/subscriptions", authed(`{"value":[{"id":"c1","skuId":"6fd2c87f","skuPartNumber":"ENTERPRISEPACK","status":"Enabled","totalLicenses":5000,"createdDateTime":"2025-07-01T00:00:00Z","nextLifecycleDateTime":"2026-07-01T00:00:00Z","isTrial":false}]}`))
	mux.HandleFunc("/v1.0/subscribedSkus", authed(`{"value":[{"skuPartNumber":"ENTERPRISEPACK","skuId":"6fd2c87f","consumedUnits":4100,"prepaidUnits":{"enabled":5000,"suspended":0,"warning":0},"capabilityStatus":"Enabled"},{"skuPartNumber":"POWER_BI_PRO","skuId":"f8a1db68","consumedUnits":300,"prepaidUnits":{"enabled":250,"suspended":0,"warning":50},"capabilityStatus":"Warning"}]}`))
	mux.HandleFunc("/v1.0/users", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("ConsistencyLevel") != "eventual" {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		authed(`{"@odata.count":4312,"value":[{}]}`)(w, r)
	})
	mux.HandleFunc("/v1.0/servicePrincipals", authed(`{"@odata.count":187,"value":[{}]}`))
	srv := httptest.NewServer(mux)
	defer srv.Close()
	cred := &contract.Credential{Type: "oauth_client", Fields: map[string]string{credClient: "app", credSecret: "s", credTenantID: "72f988bf"}}
	obs, err := Collector{}.Collect(context.Background(), contract.Target{Kind: "account", Value: "bank"}, cred, map[string]any{optionVendor: vendorM365, optionAPI: srv.URL, optionToken: srv.URL + "/token", optionScope: "graph/.default"})
	if err != nil {
		t.Fatal(err)
	}
	if seenScope != "graph/.default" {
		t.Fatalf("scope not forwarded: %q", seenScope)
	}
	types, byName := summarise(obsLike{obs.Cis, obs.Relationships})
	if types[typeVendor] != 1 || types[typeTenant] != 1 || types[typeApplication] != 2 {
		t.Fatalf("unexpected CI mix: %+v", types)
	}
	tenant := byName["Bank"]
	if tenant.Identity["tenantId"] != "72f988bf-86f1-41af-91ab-2d7cd011db47" || tenant.Attributes["users"] != int64(4312) || tenant.Attributes["ssoApplications"] != int64(187) || tenant.Attributes["seatsTotal"] != int64(5250) {
		t.Fatalf("tenant wrong: %+v", tenant.Attributes)
	}
	if byName["ENTERPRISEPACK"].Attributes["subscriptionEnd"] != "2026-07-01T00:00:00Z" || byName["ENTERPRISEPACK"].Attributes["subscriptionStart"] != "2025-07-01T00:00:00Z" || byName["POWER_BI_PRO"].Attributes["subscriptionEnd"] != nil {
		t.Fatalf("subscription terms not mapped from directory/subscriptions: %v / %v", byName["ENTERPRISEPACK"].Attributes, byName["POWER_BI_PRO"].Attributes)
	}
	if byName["POWER_BI_PRO"].Attributes["health"] != "degraded" || byName["ENTERPRISEPACK"].Attributes["seatUtilisationPercent"] != int64(82) {
		t.Fatalf("products wrong")
	}
	rels := map[string]int{}
	for _, r := range obs.Relationships {
		rels[r.Type]++
	}
	if rels[relLicensedBy] != 2 || rels[relMemberOf] != 3 {
		t.Fatalf("relationships wrong: %+v", rels)
	}
}

func TestGoogleWorkspace(t *testing.T) {
	key, _ := rsa.GenerateKey(rand.Reader, 2048)
	der, _ := x509.MarshalPKCS8PrivateKey(key)
	pemKey := string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}))
	mux := http.NewServeMux()
	var sub string
	tokenEndpoint(t, mux, "urn:ietf:params:oauth:grant-type:jwt-bearer", func(form map[string][]string) {
		parts := strings.Split(form["assertion"][0], ".")
		payload, _ := base64.RawURLEncoding.DecodeString(parts[1])
		var claims map[string]any
		_ = json.Unmarshal(payload, &claims)
		sub, _ = claims["sub"].(string)
	})
	mux.HandleFunc("/admin/directory/v1/customers/my_customer", authed(`{"id":"C01abc","customerDomain":"bank.local","language":"en","postalAddress":{"organizationName":"Bank","countryCode":"SA"}}`))
	mux.HandleFunc("/admin/directory/v1/users", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("pageToken") == "" {
			authed(`{"users":[{"suspended":false},{"suspended":true}],"nextPageToken":"p2"}`)(w, r)
			return
		}
		authed(`{"users":[{"suspended":false}]}`)(w, r)
	})
	mux.HandleFunc("/admin/directory/v1/groups", authed(`{"groups":[{},{},{}]}`))
	srv := httptest.NewServer(mux)
	defer srv.Close()
	cred := &contract.Credential{Type: "service_account", Fields: map[string]string{credEmail: "svc@proj.iam.gserviceaccount.com", credKey: pemKey, credAdmin: "admin@bank.local"}}
	obs, err := Collector{}.Collect(context.Background(), contract.Target{Kind: "account", Value: "bank.local"}, cred, map[string]any{optionVendor: vendorGoogle, optionAPI: srv.URL, optionToken: srv.URL + "/token", optionScope: "directory.readonly"})
	if err != nil {
		t.Fatal(err)
	}
	if sub != "admin@bank.local" {
		t.Fatalf("delegation subject missing: %q", sub)
	}
	_, byName := summarise(obsLike{obs.Cis, obs.Relationships})
	tenant := byName["Bank"]
	if tenant.Identity["tenantId"] != "C01abc" || tenant.Attributes["users"] != int64(3) || tenant.Attributes["activeUsers"] != int64(2) || tenant.Attributes["groups"] != int64(3) || tenant.Attributes["region"] != "SA" {
		t.Fatalf("tenant wrong: %+v", tenant.Attributes)
	}
}

func TestSalesforceServiceNowWorkday(t *testing.T) {
	mux := http.NewServeMux()
	tokenEndpoint(t, mux, "client_credentials", nil)
	mux.HandleFunc(soqlVersionPath+"/query", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query().Get("q")
		switch {
		case strings.Contains(q, "FROM Organization"):
			authed(`{"totalSize":1,"records":[{"Id":"00D5g000001","Name":"Bank CRM","OrganizationType":"Enterprise Edition","InstanceName":"EU31","IsSandbox":false}]}`)(w, r)
		case strings.Contains(q, "FROM UserLicense"):
			authed(`{"totalSize":2,"records":[{"Name":"Salesforce","TotalLicenses":600,"UsedLicenses":512,"Status":"Active"},{"Name":"Salesforce Platform","TotalLicenses":200,"UsedLicenses":40,"Status":"Active"}]}`)(w, r)
		case strings.Contains(q, "IsActive"):
			authed(`{"totalSize":552,"records":[]}`)(w, r)
		default:
			authed(`{"totalSize":610,"records":[]}`)(w, r)
		}
	})
	mux.HandleFunc(snowTablePath+"sys_properties", func(w http.ResponseWriter, r *http.Request) {
		if u, p, ok := r.BasicAuth(); !ok || u != "svc" || p != "pw" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		_, _ = w.Write([]byte(`{"result":[{"name":"instance_name","value":"bankprod"},{"name":"glide.war","value":"glide-xanadu-07-02-2024__patch3"}]}`))
	})
	mux.HandleFunc(snowStatsPath+"sys_user", func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.RawQuery, "active") {
			_, _ = w.Write([]byte(`{"result":{"stats":{"count":"1450"}}}`))
			return
		}
		_, _ = w.Write([]byte(`{"result":{"stats":{"count":"1600"}}}`))
	})
	mux.HandleFunc(snowTablePath+"license_details", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"result":[{"name":"ITSM Pro","purchased_count":"1500","allocated_count":"1450","state":"active"}]}`))
	})
	mux.HandleFunc("/ccx/api/v1/bank/workers", authed(`{"total":9876,"data":[{}]}`))
	srv := httptest.NewServer(mux)
	defer srv.Close()

	oauth := &contract.Credential{Type: "oauth_client", Fields: map[string]string{credClient: "app", credSecret: "s"}}
	sf, err := Collector{}.Collect(context.Background(), contract.Target{Kind: "account", Value: "bank-crm"}, oauth, map[string]any{optionVendor: vendorSalesforce, optionAPI: srv.URL, optionToken: srv.URL + "/token"})
	if err != nil {
		t.Fatal(err)
	}
	_, byName := summarise(obsLike{sf.Cis, sf.Relationships})
	if byName["Bank CRM"].Attributes["activeUsers"] != int64(552) || byName["Bank CRM"].Attributes["users"] != int64(610) || byName["Salesforce"].Attributes["seatsAssigned"] != int64(512) || byName["Bank CRM"].Attributes["region"] != "EU31" {
		t.Fatalf("salesforce wrong: %+v", byName["Bank CRM"].Attributes)
	}

	snow, err := Collector{}.Collect(context.Background(), contract.Target{Kind: "account", Value: "bankprod"}, &contract.Credential{Type: "password", Fields: map[string]string{credUser: "svc", credPassword: "pw"}}, map[string]any{optionVendor: vendorServiceNow, optionAPI: srv.URL})
	if err != nil {
		t.Fatal(err)
	}
	_, byName = summarise(obsLike{snow.Cis, snow.Relationships})
	if byName["bankprod"].Attributes["activeUsers"] != int64(1450) || byName["bankprod"].Attributes["edition"] != "glide-xanadu-07-02-2024__patch3" || byName["ITSM Pro"].Attributes["seatsTotal"] != int64(1500) {
		t.Fatalf("servicenow wrong: %+v", byName["bankprod"].Attributes)
	}

	wd, err := Collector{}.Collect(context.Background(), contract.Target{Kind: "account", Value: "bank"}, oauth, map[string]any{optionVendor: vendorWorkday, optionAPI: srv.URL, optionToken: srv.URL + "/token"})
	if err != nil {
		t.Fatal(err)
	}
	_, byName = summarise(obsLike{wd.Cis, wd.Relationships})
	if byName["bank"].Attributes["users"] != int64(9876) || byName["Workday HCM"].Attributes["seatsAssigned"] != int64(9876) {
		t.Fatalf("workday wrong: %+v", byName["bank"].Attributes)
	}

	if _, err := (Collector{}).Collect(context.Background(), contract.Target{Kind: "account", Value: "x"}, oauth, map[string]any{optionVendor: "unknown-vendor", optionAPI: srv.URL}); err == nil {
		t.Fatal("unknown vendor must fail")
	}
	bad := &contract.Credential{Type: "password", Fields: map[string]string{credUser: "svc", credPassword: "wrong"}}
	if _, err := (Collector{}).Collect(context.Background(), contract.Target{Kind: "account", Value: "bankprod"}, bad, map[string]any{optionVendor: vendorServiceNow, optionAPI: srv.URL}); err == nil || !strings.Contains(err.Error(), contract.ErrAuthFailed) {
		t.Fatalf("expected auth_failed, got %v", err)
	}
}
