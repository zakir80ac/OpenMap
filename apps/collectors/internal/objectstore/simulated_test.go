// T-398 REQ-DISC-017 REQ-QA-005 — gap the simulated S3 endpoints exposed: Collect pins a private CA
// (caCertPem) with verifyTls on, so on-premises object stores behind an enterprise CA verify their chain.
package objectstore

import (
	"context"
	"encoding/pem"
	"testing"

	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

func TestCollectPinsCACertificate(t *testing.T) {
	srv := server(t)
	defer srv.Close()
	caPem := string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: srv.Certificate().Raw}))
	cred := &contract.Credential{Type: "api_token", Fields: map[string]string{credAccessKey: "AKIATEST", credSecretKey: "secret"}}
	target := contract.Target{Kind: "url", Value: srv.URL}
	obs, err := Collector{}.Collect(context.Background(), target, cred, map[string]any{optionPathStyle: true, optionVerify: true, optionCA: caPem})
	if err != nil {
		t.Fatalf("pinned CA rejected: %v", err)
	}
	if len(obs.Cis) != 2 {
		t.Fatalf("expected two buckets through the pinned client, got %d", len(obs.Cis))
	}
	if _, err := (Collector{}).Collect(context.Background(), target, cred, map[string]any{optionPathStyle: true, optionVerify: true}); err == nil {
		t.Fatal("verifyTls without the CA must reject the test certificate")
	}
}
