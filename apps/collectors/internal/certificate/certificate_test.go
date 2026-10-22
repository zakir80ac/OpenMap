// T-040 REQ-DISC-025 — handshakes with an httptest TLS server (self-signed leaf) and checks the
// certificate CI, the secured listening service and expiry arithmetic.
package certificate

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"testing"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

func TestProbeAndEmit(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) }))
	defer srv.Close()
	u, _ := url.Parse(srv.URL)
	port, _ := strconv.Atoi(u.Port())
	ep := Probe(context.Background(), u.Hostname(), port, "example.com")
	if ep.Error != "" || len(ep.Chain) == 0 {
		t.Fatalf("handshake failed: %+v", ep)
	}
	if ep.Verified {
		t.Fatal("self-signed test certificate should not verify against system roots")
	}
	obs := Emit([]Endpoint{ep}, contract.Target{Kind: "host", Value: u.Hostname()}, time.Now())
	if len(obs.Cis) != 2 || obs.Cis[0].Type != typeCertificate || obs.Cis[1].Type != typeListener {
		t.Fatalf("unexpected CIs: %+v", obs.Cis)
	}
	cert := obs.Cis[0]
	if len(cert.Identity["fingerprintSha256"]) != 64 || cert.Attributes["expired"] != false || cert.Attributes["keyAlgorithm"] == "" {
		t.Fatalf("certificate attributes wrong: %+v", cert)
	}
	if obs.Cis[1].Attributes["tls"] != true || obs.Cis[1].Identity["port"] != strconv.Itoa(port) {
		t.Fatalf("listener wrong: %+v", obs.Cis[1])
	}
	if len(obs.Relationships) != 1 || obs.Relationships[0].Type != relSecuredBy {
		t.Fatalf("relationships wrong: %+v", obs.Relationships)
	}
	if len(obs.Evidence) != 1 {
		t.Fatalf("expected one evidence record per certificate, got %d", len(obs.Evidence))
	}
}

func TestSplitTarget(t *testing.T) {
	h, p, ok := splitTarget("https://portal.example:8443/login")
	if h != "portal.example" || p != 8443 || !ok {
		t.Fatalf("url split wrong: %s %d %v", h, p, ok)
	}
	h, _, ok = splitTarget("portal.example")
	if h != "portal.example" || ok {
		t.Fatalf("bare host split wrong: %s %v", h, ok)
	}
}

func TestCollectUnreachable(t *testing.T) {
	_, err := Collector{}.Collect(context.Background(), contract.Target{Kind: "host", Value: "127.0.0.1:1"}, nil, map[string]any{})
	if err == nil {
		t.Fatal("expected unreachable error")
	}
}
