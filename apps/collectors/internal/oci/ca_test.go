// T-428 REQ-DISC-010 REQ-QA-005 — every OCI service client trusts the job's caCertPem (dedicated regions and
// proxies behind a private CA): a signed run completes with verification on, and without the bundle the private
// CA fails verification instead of being skipped.
package oci

import (
	"context"
	"encoding/pem"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

func TestPrivateCAForEveryService(t *testing.T) {
	key, pemKey := testKey(t)
	plain := server(t, &key.PublicKey)
	defer plain.Close()
	srv := httptest.NewTLSServer(plain.Config.Handler)
	defer srv.Close()
	caPem := string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: srv.Certificate().Raw}))
	cred := &contract.Credential{Type: credType, Fields: map[string]string{credTenancy: "ocid1.tenancy.oc1..t", credUser: "ocid1.user.oc1..u", credFinger: "aa:bb:cc", credKey: pemKey}}
	job := func(ca string) map[string]any {
		return map[string]any{optionIdentity: srv.URL, optionCore: srv.URL, optionDatabase: srv.URL, optionContainer: srv.URL, optionLB: srv.URL, optionCA: ca}
	}
	obs, err := Collector{}.Collect(context.Background(), contract.Target{Kind: "account", Value: "ocid1.tenancy.oc1..t"}, cred, job(caPem))
	if err != nil {
		t.Fatal(err)
	}
	kinds := map[string]int{}
	for _, c := range obs.Cis {
		kinds[c.Type]++
	}
	if kinds[typeVM] != 2 || kinds[typeDBClust] != 1 || kinds[typeLB] != 1 {
		t.Fatalf("run behind the private CA missed services: %+v", kinds)
	}
	if _, err := (Collector{}).Collect(context.Background(), contract.Target{Kind: "account", Value: "ocid1.tenancy.oc1..t"}, cred, job("")); err == nil || !strings.Contains(err.Error(), contract.ErrUnreachable) {
		t.Fatalf("expected the unverified private CA to fail as unreachable, got %v", err)
	}
	if _, err := (Collector{}).Collect(context.Background(), contract.Target{Kind: "account", Value: "x"}, cred, job("not a pem")); err == nil {
		t.Fatal("expected a caCertPem without a certificate to be rejected")
	}
}
