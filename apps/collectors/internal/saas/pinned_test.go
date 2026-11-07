// T-442 REQ-QA-005 REQ-CMDB-022 — regression the simulated SaaS tenants exposed: the token endpoint (client
// credentials and the Google JWT-bearer exchange) and the API client ignored caCertPem and trusted only the
// system pool, so a tenant reached through a private-CA gateway failed TLS. Both now pin the job's CA bundle.
package saas

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

func TestTokenAndAPIPinPrivateCA(t *testing.T) {
	mux := http.NewServeMux()
	tokenEndpoint(t, mux, "client_credentials", nil)
	mux.HandleFunc("/ccx/api/v1/bank/workers", authed(`{"total":12,"data":[{}]}`))
	srv := httptest.NewTLSServer(mux)
	defer srv.Close()
	ca := string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: srv.Certificate().Raw}))
	oauth := &contract.Credential{Type: "oauth_client", Fields: map[string]string{credClient: "app", credSecret: "s"}}
	opts := map[string]any{optionVendor: vendorWorkday, optionAPI: srv.URL, optionToken: srv.URL + "/token", optionTenant: "bank"}

	if _, err := (Collector{}).Collect(context.Background(), contract.Target{Kind: "account", Value: "bank"}, oauth, opts); err == nil || !strings.Contains(err.Error(), contract.ErrUnreachable) {
		t.Fatalf("a private-CA token endpoint must fail TLS without caCertPem, got %v", err)
	}
	opts[optionCA] = ca
	obs, err := Collector{}.Collect(context.Background(), contract.Target{Kind: "account", Value: "bank"}, oauth, opts)
	if err != nil {
		t.Fatalf("with caCertPem the token endpoint and API must verify: %v", err)
	}
	if len(obs.Cis) == 0 {
		t.Fatal("no CIs emitted")
	}

	key, _ := rsa.GenerateKey(rand.Reader, 2048)
	der, _ := x509.MarshalPKCS8PrivateKey(key)
	gmux := http.NewServeMux()
	tokenEndpoint(t, gmux, grantJWTBearer, nil)
	gmux.HandleFunc("/admin/directory/v1/customers/my_customer", authed(`{"id":"C01abc","customerDomain":"bank.local"}`))
	gmux.HandleFunc("/admin/directory/v1/users", authed(`{"users":[{"suspended":false}]}`))
	gmux.HandleFunc("/admin/directory/v1/groups", authed(`{"groups":[]}`))
	gsrv := httptest.NewTLSServer(gmux)
	defer gsrv.Close()
	gca := string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: gsrv.Certificate().Raw}))
	sa := &contract.Credential{Type: "service_account", Fields: map[string]string{credEmail: "svc@proj.iam.gserviceaccount.com", credKey: string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})), credAdmin: "admin@bank.local"}}
	if _, err := (Collector{}).Collect(context.Background(), contract.Target{Kind: "account", Value: "bank.local"}, sa, map[string]any{optionVendor: vendorGoogle, optionAPI: gsrv.URL, optionToken: gsrv.URL + "/token", optionScope: "directory.readonly", optionCA: gca}); err != nil {
		t.Fatalf("the JWT-bearer exchange must pin caCertPem too: %v", err)
	}
}
