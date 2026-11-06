// T-306 REQ-DISC-018 — replays the exchanges recorded from a real open-source NGINX container (the
// Plus API probe answered 404, then stub_status) through the real Collect path and checks the load
// balancer CI and the stub_status counters it carries.
package nginx

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

const fixtureFamily = "../../../../packages/testing/fixtures/vendor/load_balancer"

type fixtureManifest struct {
	Vendor   string `json:"vendor"`
	Model    string `json:"model"`
	Firmware string `json:"firmware"`
}

type recordedExchange struct {
	Method  string            `json:"method"`
	Path    string            `json:"path"`
	Status  int               `json:"status"`
	Headers map[string]string `json:"headers"`
	Body    string            `json:"body"`
}

// replay serves the recorded exchanges of one fixture directory, keyed by method and request URI.
func replay(t *testing.T, dir string) (*httptest.Server, *[]string) {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(dir, "exchanges.json"))
	if err != nil {
		t.Fatal(err)
	}
	var list []recordedExchange
	if err := json.Unmarshal(raw, &list); err != nil {
		t.Fatal(err)
	}
	byKey := map[string]recordedExchange{}
	for _, e := range list {
		byKey[e.Method+" "+e.Path] = e
	}
	requested := []string{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requested = append(requested, r.URL.RequestURI())
		e, ok := byKey[r.Method+" "+r.URL.RequestURI()]
		if !ok {
			t.Errorf("collector requested %s %s, which the recording does not hold", r.Method, r.URL.RequestURI())
			w.WriteHeader(http.StatusNotFound)
			return
		}
		body, err := os.ReadFile(filepath.Join(dir, e.Body))
		if err != nil {
			t.Error(err)
		}
		for k, v := range e.Headers {
			w.Header().Set(k, v)
		}
		w.WriteHeader(e.Status)
		_, _ = w.Write(body)
	}))
	t.Cleanup(srv.Close)
	return srv, &requested
}

type nginxExpect struct {
	edition, model                                             string
	active, accepts, handled, requests, reading, writing, wait int64
}

var nginxFixtures = map[string]nginxExpect{
	"nginx-nginx-1.29.5": {edition: "open-source", model: "nginx/1.29.5", active: 1, accepts: 27, handled: 27, requests: 28, reading: 0, writing: 1, wait: 0},
}

func TestREQDISC018_T306_RecordedVendorFixtures(t *testing.T) {
	entries, err := os.ReadDir(fixtureFamily)
	if err != nil {
		t.Fatal(err)
	}
	seen := 0
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		dir := filepath.Join(fixtureFamily, entry.Name())
		raw, err := os.ReadFile(filepath.Join(dir, "manifest.json"))
		if err != nil {
			t.Fatalf("%s: %v", entry.Name(), err)
		}
		var m fixtureManifest
		if err := json.Unmarshal(raw, &m); err != nil {
			t.Fatalf("%s: %v", entry.Name(), err)
		}
		if m.Vendor != vendor {
			continue
		}
		seen++
		want, ok := nginxFixtures[entry.Name()]
		if !ok {
			t.Fatalf("fixture %s has no expectation row", entry.Name())
		}
		t.Run(entry.Name(), func(t *testing.T) {
			srv, requested := replay(t, dir)
			obs, err := Collector{}.Collect(context.Background(), contract.Target{Kind: "url", Value: srv.URL}, nil, map[string]any{})
			if err != nil {
				t.Fatal(err)
			}
			if len(*requested) != 2 || (*requested)[0] != defaultAPI+"/" || (*requested)[1] != defaultStatus {
				t.Fatalf("request sequence %v", *requested)
			}
			if len(obs.Cis) != 1 || len(obs.Relationships) != 0 || len(obs.Evidence) == 0 {
				t.Fatalf("observation shape: %d CIs, %d relationships, %d evidence", len(obs.Cis), len(obs.Relationships), len(obs.Evidence))
			}
			lb := obs.Cis[0]
			if lb.Type != typeLB || lb.Identity["serialNumber"] != vendor+":127.0.0.1" || lb.Identity["managementIp"] != "127.0.0.1" {
				t.Fatalf("load balancer identity %+v", lb.Identity)
			}
			a := lb.Attributes
			if a["edition"] != want.edition || a["model"] != want.model || a["vendor"] != vendor {
				t.Fatalf("load balancer facts %+v", a)
			}
			counters := map[string]int64{"activeConnections": want.active, "acceptedConnections": want.accepts, "handledConnections": want.handled, "requests": want.requests, "reading": want.reading, "writing": want.writing, "waiting": want.wait}
			for k, v := range counters {
				if a[k] != v {
					t.Fatalf("%s = %v, recorded %d", k, a[k], v)
				}
			}
		})
	}
	if seen == 0 || seen != len(nginxFixtures) {
		t.Fatalf("found %d NGINX fixtures, expected %d", seen, len(nginxFixtures))
	}
}
