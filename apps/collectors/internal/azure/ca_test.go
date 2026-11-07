// T-426 REQ-DISC-010 REQ-QA-005 — the job's caCertPem is trusted at the Entra token endpoint as well as at ARM, so a
// sovereign cloud, Azure Stack Hub or proxy behind a private CA completes a run with verification on; without the
// bundle the private CA fails verification instead of being skipped.
package azure

import (
	"context"
	"encoding/pem"
	"strings"
	"testing"

	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

func TestPrivateCAAtTokenEndpointAndARM(t *testing.T) {
	srv := arm(t)
	defer srv.Close()
	caPem := string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: srv.Certificate().Raw}))
	cred := &contract.Credential{Type: "oauth_client", Fields: map[string]string{credClientID: "client", credSecret: "s3cret", credTenant: "tenant-1"}}
	job := func(ca string) map[string]any {
		return map[string]any{optionAuthority: srv.URL, optionArm: srv.URL, optionCA: ca}
	}
	obs, err := Collector{}.Collect(context.Background(), contract.Target{Kind: "account", Value: sub}, cred, job(caPem))
	if err != nil {
		t.Fatal(err)
	}
	if count(obs.Cis, typeAccount) != 1 || count(obs.Cis, typeVM) != 1 {
		t.Fatalf("run behind the private CA emitted %d accounts and %d VMs", count(obs.Cis, typeAccount), count(obs.Cis, typeVM))
	}
	if _, err := (Collector{}).Collect(context.Background(), contract.Target{Kind: "account", Value: sub}, cred, job("")); err == nil || !strings.Contains(err.Error(), contract.ErrUnreachable) {
		t.Fatalf("expected the unverified private CA to fail as unreachable, got %v", err)
	}
	if _, err := (Collector{}).Collect(context.Background(), contract.Target{Kind: "account", Value: sub}, cred, job("not a pem")); err == nil {
		t.Fatal("expected a caCertPem without a certificate to be rejected")
	}
}
