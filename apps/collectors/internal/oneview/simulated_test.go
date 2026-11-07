// T-397 REQ-DISC-013 REQ-QA-005 — gaps the simulated OneView appliance exposed: a server is named by its
// serverName (the operating system host name), never by mpHostName (the iLO's own DNS name), and cpuCores is
// processorCount times processorCoreCount, which OneView reports per processor; Collect deletes its login
// session when the walk ends.
package oneview

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

func TestServerNameAndCoreCount(t *testing.T) {
	s := ServerHardware{URI: "/rest/server-hardware/1", Name: "ILOCZJ7LA1GE.bank.local", ServerName: "esx-ryd-c01-11", SerialNumber: "CZJ7LA1GE", ProcessorCount: 2, ProcessorCore: 32}
	s.MpHost.HostName = "ILOCZJ7LA1GE.bank.local"
	obs := Emit(&Inventory{Servers: []ServerHardware{s}}, contract.Target{Kind: "host", Value: "oneview"}, time.Now())
	host := obs.Cis[0]
	if host.Type != typeHost || host.Name != "esx-ryd-c01-11" || host.Attributes["cpuCores"] != 64 || host.Attributes["hostname"] != "esx-ryd-c01-11" {
		t.Fatalf("host wrong: %+v", host)
	}
	s.ServerName = ""
	obs = Emit(&Inventory{Servers: []ServerHardware{s}}, contract.Target{Kind: "host", Value: "oneview"}, time.Now())
	if obs.Cis[0].Name != s.Name {
		t.Fatalf("without serverName the OneView name is used: %+v", obs.Cis[0])
	}
}

func TestCollectClosesTheSession(t *testing.T) {
	deleted := ""
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/rest/login-sessions" && r.Method == http.MethodPost:
			_ = json.NewEncoder(w).Encode(map[string]string{"sessionID": "sess-9"})
		case r.URL.Path == "/rest/login-sessions" && r.Method == http.MethodDelete:
			deleted = r.Header.Get(sessionHeader)
			w.WriteHeader(http.StatusNoContent)
		default:
			_ = json.NewEncoder(w).Encode(map[string]any{"members": []any{}})
		}
	}))
	defer srv.Close()
	cred := &contract.Credential{Type: "password", Fields: map[string]string{credUser: "Administrator", credPassword: "pw"}}
	if _, err := (Collector{}).Collect(context.Background(), contract.Target{Kind: "host", Value: srv.URL}, cred, map[string]any{}); err != nil {
		t.Fatal(err)
	}
	if deleted != "sess-9" {
		t.Fatalf("session not closed, DELETE carried %q", deleted)
	}
}
