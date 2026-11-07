// T-375 REQ-QA-005 REQ-DISC-002 — regression for a gap the simulated WinRM listener exposed: WinRM over HTTPS
// ignored caCertPem (verifyTls=true could only trust the system pool) and had no way to verify a listener
// certificate issued for a name when the target is an address. The listener here answers 401 to everything, so a
// run that reaches it proves the TLS handshake passed and a run that does not shows the verification failure.
package winrmexec

import (
	"context"
	"encoding/pem"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"testing"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/collector"
	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

const testTimeoutSeconds = 5

func listener(t *testing.T) (*httptest.Server, string, int) {
	t.Helper()
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("WWW-Authenticate", `Basic realm="WSMAN"`)
		w.WriteHeader(http.StatusUnauthorized)
	}))
	t.Cleanup(srv.Close)
	u, err := url.Parse(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	_, portText, err := net.SplitHostPort(u.Host)
	if err != nil {
		t.Fatal(err)
	}
	port, err := strconv.Atoi(portText)
	if err != nil {
		t.Fatal(err)
	}
	caPem := string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: srv.Certificate().Raw}))
	return srv, caPem, port
}

func code(t *testing.T, err error) string {
	t.Helper()
	var te *collector.TargetError
	if !errors.As(err, &te) {
		t.Fatalf("expected a target error, got %v", err)
	}
	return te.Code
}

func run(t *testing.T, host string, options map[string]any) error {
	t.Helper()
	cred := &contract.Credential{Type: "password", Fields: map[string]string{credUser: "auditor", credPassword: "wrong"}}
	ctx, cancel := context.WithTimeout(context.Background(), testTimeoutSeconds*time.Second)
	defer cancel()
	_, err := Run(ctx, contract.Target{Kind: "host", Value: host}, cred, options, "Get-Date")
	return err
}

func TestREQDISC002_T375_CaCertPemAndServerName(t *testing.T) {
	_, caPem, port := listener(t)
	base := func(extra map[string]any) map[string]any {
		o := map[string]any{OptionAuth: authBasic, OptionTLS: true, OptionPort: port, OptionTimeout: testTimeoutSeconds}
		for k, v := range extra {
			o[k] = v
		}
		return o
	}
	if got := code(t, run(t, "127.0.0.1", base(map[string]any{OptionVerify: true}))); got != contract.ErrUnreachable {
		t.Fatalf("private CA without caCertPem must fail verification, got %s", got)
	}
	if got := code(t, run(t, "127.0.0.1", base(map[string]any{OptionVerify: true, OptionCA: caPem}))); got != contract.ErrAuthFailed {
		t.Fatalf("caCertPem must let the handshake verify, got %s", got)
	}
	if got := code(t, run(t, "127.0.0.1", base(map[string]any{OptionCA: caPem}))); got != contract.ErrAuthFailed {
		t.Fatalf("caCertPem alone must verify against that pool, got %s", got)
	}
	if got := code(t, run(t, "localhost", base(map[string]any{OptionCA: caPem}))); got != contract.ErrUnreachable {
		t.Fatalf("a name the certificate does not carry must fail verification, got %s", got)
	}
	if got := code(t, run(t, "localhost", base(map[string]any{OptionCA: caPem, OptionServerName: "example.com"}))); got != contract.ErrAuthFailed {
		t.Fatalf("tlsServerName must be the name verified, got %s", got)
	}
	if got := code(t, run(t, "127.0.0.1", base(map[string]any{OptionCA: "not a certificate"}))); got != contract.ErrInternal {
		t.Fatalf("an unreadable caCertPem must be reported, got %s", got)
	}
}
