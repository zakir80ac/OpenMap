// T-045 REQ-DISC-014 — serves FlashArray REST 2.x-shaped login, arrays, hardware, controllers,
// volumes (paged), hosts and connections from httptest and checks array, LUN and presentation emission.
package purestorage

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/contract"
	"github.com/openmap/openmap/apps/collectors/internal/restjson"
)

func server(t *testing.T) *httptest.Server {
	t.Helper()
	return httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/login") {
			if r.Header.Get(apiTokenHdr) != "api-token-1" {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			w.Header().Set(authHeader, "session-1")
			w.WriteHeader(http.StatusOK)
			return
		}
		if r.Header.Get(authHeader) != "session-1" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.HasSuffix(r.URL.Path, "/arrays"):
			_ = json.NewEncoder(w).Encode(map[string]any{"items": []any{map[string]any{"id": "arr-1", "name": "PURE-RYD-01", "os": "Purity//FA", "version": "6.6.8", "capacity": 274877906944000, "space": map[string]any{"total_physical": 98765432100000, "data_reduction": 4.2, "snapshots": 1000}}}})
		case strings.HasSuffix(r.URL.Path, "/hardware"):
			_ = json.NewEncoder(w).Encode(map[string]any{"items": []any{map[string]any{"name": "CH0", "type": "chassis", "serial": "PCHFL23420ABC", "model": "FA-X70R4", "status": "ok"}}})
		case strings.HasSuffix(r.URL.Path, "/controllers"):
			_ = json.NewEncoder(w).Encode(map[string]any{"items": []any{map[string]any{"name": "CT0", "model": "FA-X70R4", "status": "ready", "mode": "primary", "version": "6.6.8"}, map[string]any{"name": "CT1", "model": "FA-X70R4", "status": "ready", "mode": "secondary", "version": "6.6.8"}}})
		case strings.HasSuffix(r.URL.Path, "/volumes") && r.URL.Query().Get("continuation_token") == "":
			_ = json.NewEncoder(w).Encode(map[string]any{"items": []any{map[string]any{"name": "pg-core-data", "serial": "F1E2D3C4B5A6978812345678", "provisioned": 2199023255552, "created": 1700000000000, "space": map[string]any{"total_physical": 500000000000}, "volume_group": map[string]string{"name": "vg-db"}}}, "continuation_token": "page2"})
		case strings.HasSuffix(r.URL.Path, "/volumes"):
			_ = json.NewEncoder(w).Encode(map[string]any{"items": []any{map[string]any{"name": "old-vol", "serial": "DEADBEEF", "destroyed": true}}})
		case strings.HasSuffix(r.URL.Path, "/hosts"):
			_ = json.NewEncoder(w).Encode(map[string]any{"items": []any{map[string]any{"name": "db-ryd-pg-core-01", "wwns": []string{"10:00:00:90:FA:AA:BB:01", "10:00:00:90:FA:AA:BB:02"}, "personality": "", "host_group": map[string]string{"name": "hg-db"}}}})
		case strings.HasSuffix(r.URL.Path, "/connections"):
			_ = json.NewEncoder(w).Encode(map[string]any{"items": []any{map[string]any{"host": map[string]string{"name": "db-ryd-pg-core-01"}, "volume": map[string]string{"name": "pg-core-data"}, "lun": 1}, map[string]any{"host": map[string]string{"name": "db-ryd-pg-core-01"}, "volume": map[string]string{"name": "old-vol"}, "lun": 2}}})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
}

func TestLoginWalkEmit(t *testing.T) {
	srv := server(t)
	defer srv.Close()
	session, err := Login(context.Background(), srv.URL, defaultAPI, "api-token-1", false)
	if err != nil || session != "session-1" {
		t.Fatalf("login failed: %v %q", err, session)
	}
	c, _ := restjson.New(srv.URL, defaultPort, restjson.Auth{}, restjson.Options{Headers: map[string]string{authHeader: session}})
	inv, err := Walk(context.Background(), c, defaultAPI)
	if err != nil {
		t.Fatal(err)
	}
	if len(inv.Volumes) != 2 || Serial(inv) != "PCHFL23420ABC" {
		t.Fatalf("walk wrong: volumes=%d serial=%s", len(inv.Volumes), Serial(inv))
	}
	obs := Emit(inv, contract.Target{Kind: "host", Value: "pure-ryd-01.corp.example"}, time.Now())
	if len(obs.Cis) != 2 || obs.Cis[0].Type != typeArray || obs.Cis[1].Type != typeLun {
		t.Fatalf("unexpected CIs: %+v", obs.Cis)
	}
	if obs.Cis[1].Identity["wwn"] != "naa.624a9370f1e2d3c4b5a6978812345678" || obs.Cis[1].Identity["arrayRef"] != "PCHFL23420ABC" || obs.Cis[1].Attributes["volumeGroup"] != "vg-db" {
		t.Fatalf("lun wrong: %+v", obs.Cis[1])
	}
	rels := map[string]int{}
	for _, r := range obs.Relationships {
		rels[r.Type]++
		if r.Type == relPresented {
			if r.To.Identity["fqdn"] != "db-ryd-pg-core-01" || r.Attributes["lun"] != 1 {
				t.Fatalf("presentation wrong: %+v", r)
			}
			wwns, _ := r.Attributes["initiatorWwns"].([]string)
			if len(wwns) != 2 || wwns[0] != "10000090faaabb01" {
				t.Fatalf("initiator wwns wrong: %+v", wwns)
			}
		}
	}
	if rels[relContains] != 1 || rels[relPresented] != 1 {
		t.Fatalf("relationship mix wrong: %+v", rels)
	}
}

func TestBadToken(t *testing.T) {
	srv := server(t)
	defer srv.Close()
	if _, err := Login(context.Background(), srv.URL, defaultAPI, "nope", false); err == nil || !strings.Contains(err.Error(), contract.ErrAuthFailed) {
		t.Fatalf("expected auth_failed, got %v", err)
	}
}
