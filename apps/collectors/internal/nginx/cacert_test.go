// T-437 REQ-QA-005 REQ-DISC-018 — regressions found by the simulated NGINX: stub_status behind a private CA is
// fetched over the job's pinned CA (caCertPem) like the Plus API probe (the stub transport ignored caCertPem,
// so an open-source instance with verifyTls=true failed verification after the API 404); and a Plus server
// zone named after its upstream keeps its own identity, so its depends_on edge reaches the upstream pool
// instead of the zone itself.
package nginx

import (
	"context"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

func TestStubStatusBehindPrivateCA(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != defaultStatus {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Header().Set("Server", "nginx/1.26.2")
		_, _ = w.Write([]byte("Active connections: 3 \nserver accepts handled requests\n 120 120 410 \nReading: 0 Writing: 1 Waiting: 2 \n"))
	}))
	defer srv.Close()
	caPem := string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: srv.Certificate().Raw}))
	target := contract.Target{Kind: "url", Value: srv.URL}

	obs, err := Collector{}.Collect(context.Background(), target, nil, map[string]any{optionVerify: true, optionCA: caPem})
	if err != nil {
		t.Fatalf("pinned CA rejected for stub_status: %v", err)
	}
	if len(obs.Cis) != 1 || obs.Cis[0].Attributes["requests"] != int64(410) || obs.Cis[0].Attributes["edition"] != "open-source" {
		t.Fatalf("stub_status load balancer wrong: %+v", obs.Cis)
	}
	if _, err := (Collector{}).Collect(context.Background(), target, nil, map[string]any{optionVerify: true}); err == nil {
		t.Fatal("an unknown CA was accepted with verification on")
	}
}

func TestZoneNamedAfterUpstreamStaysDistinct(t *testing.T) {
	inv := &Inventory{Plus: true,
		Zones:     map[string]ServerZone{"cbs-api": {Requests: 10}},
		Upstreams: map[string]Upstream{"cbs-api": {Zone: "cbs-api", Peers: []Peer{{Server: "10.4.0.30:8443", Name: "api-ryd-cbs-01.bank.local:8443", State: "up"}}}},
	}
	obs := Emit(inv, contract.Target{Kind: "url", Value: "https://10.4.3.200"}, "", time.Now())
	keys := map[string]string{}
	for _, ci := range obs.Cis {
		if ci.Type != typeListener {
			continue
		}
		k := ci.Identity["hostRef"] + "|" + ci.Identity["port"]
		if prev, dup := keys[k]; dup {
			t.Fatalf("%s and %s share the listener identity %s", prev, ci.Name, k)
		}
		keys[k] = ci.Name
	}
	linked := false
	for _, r := range obs.Relationships {
		if r.Type != relDependsOn || r.From.Identity["port"] != "cbs-api"+frontendSuffix {
			continue
		}
		if r.To.Identity["port"] != "cbs-api" {
			t.Fatalf("zone edge reaches %+v", r.To)
		}
		linked = true
	}
	if !linked {
		t.Fatalf("no depends_on from the zone to its upstream: %+v", obs.Relationships)
	}
}
