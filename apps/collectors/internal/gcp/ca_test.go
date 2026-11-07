// T-427 REQ-DISC-010 REQ-QA-005 — the OAuth token endpoint honours the job's caCertPem like the Compute, SQL and GKE
// clients: a private-access or sovereign deployment whose token endpoint sits behind a private CA completes a run
// with verification on, and without the bundle the token exchange fails verification instead of being skipped.
package gcp

import (
	"context"
	"encoding/pem"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

func TestPrivateCAAtTokenEndpoint(t *testing.T) {
	key, pemKey := testKey(t)
	plain := server(t, key)
	defer plain.Close()
	srv := httptest.NewTLSServer(plain.Config.Handler)
	defer srv.Close()
	caPem := string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: srv.Certificate().Raw}))
	cred := &contract.Credential{Type: credType, Fields: map[string]string{credEmail: "openmap@bank-prod.iam.gserviceaccount.com", credPrivateKey: pemKey}}
	job := func(ca string) map[string]any {
		return map[string]any{optionTokenURL: srv.URL + "/token", optionScope: "cloud-platform.read-only", optionCompute: srv.URL, optionSQLAdmin: srv.URL, optionContainer: srv.URL, optionCA: ca}
	}
	obs, err := Collector{}.Collect(context.Background(), contract.Target{Kind: "account", Value: "bank-prod"}, cred, job(caPem))
	if err != nil {
		t.Fatal(err)
	}
	vms := 0
	for _, c := range obs.Cis {
		if c.Type == typeVM {
			vms++
		}
	}
	if vms != 2 {
		t.Fatalf("run behind the private CA emitted %d VMs", vms)
	}
	if _, err := (Collector{}).Collect(context.Background(), contract.Target{Kind: "account", Value: "bank-prod"}, cred, job("")); err == nil || !strings.Contains(err.Error(), contract.ErrUnreachable) || !strings.Contains(err.Error(), "token endpoint") {
		t.Fatalf("expected the token exchange to fail verification, got %v", err)
	}
	if _, err := TokenCA(context.Background(), srv.URL+"/token", "x", "not a pem"); err == nil {
		t.Fatal("expected a caCertPem without a certificate to be rejected")
	}
}
