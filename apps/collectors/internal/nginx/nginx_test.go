// T-066 REQ-DISC-018 — NGINX Plus API served by httptest (versions, nginx facts, server zones, upstreams with peer
// health) and the open-source stub_status page; checks the load balancer, zone listeners, upstream pools, members
// and dependency edges, and the fallback when only stub_status exists.
package nginx

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/contract"
	"github.com/openmap/openmap/apps/collectors/internal/restjson"
)

const stubPage = "Active connections: 291 \nserver accepts handled requests\n 16630948 16630948 31070465 \nReading: 6 Writing: 179 Waiting: 106 \n"

func plusServer(t *testing.T) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/":
			_, _ = w.Write([]byte(`[1,2,3,4,5,6,7,8,9]`))
		case "/api/9/nginx":
			_, _ = w.Write([]byte(`{"version":"1.25.5","build":"nginx-plus-r32","address":"10.191.7.5","generation":3,"load_timestamp":"2026-10-01T08:00:00Z","timestamp":"2026-10-22T10:00:00Z","pid":1234,"ppid":1}`))
		case "/api/9/http/server_zones":
			_, _ = w.Write([]byte(`{"shop":{"processing":4,"requests":120000,"discarded":3,"received":9000000,"sent":880000000,"responses":{"total":119997}}}`))
		case "/api/9/http/upstreams":
			_, _ = w.Write([]byte(`{"shop":{"zone":"shop_up","zombies":0,"peers":[
				{"id":0,"server":"10.191.3.21:8080","name":"shop01","backup":false,"weight":1,"state":"up","active":2,"requests":60000,"downtime":0,"health_checks":{"checks":500,"fails":0,"unhealthy":0}},
				{"id":1,"server":"10.191.3.22:8080","name":"shop02","backup":false,"weight":1,"state":"unhealthy","active":0,"requests":59000,"downtime":120000,"health_checks":{"checks":500,"fails":12,"unhealthy":1}},
				{"id":2,"server":"shop-backup.example.internal:8080","name":"shop-bk","backup":true,"weight":1,"state":"up","active":0,"requests":0,"downtime":0,"health_checks":{"checks":500,"fails":0,"unhealthy":0}}]}}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})
	mux.HandleFunc("/stub_status", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Server", "nginx/1.25.5")
		_, _ = w.Write([]byte(stubPage))
	})
	return httptest.NewServer(mux)
}

func TestPlusWalkAndEmit(t *testing.T) {
	srv := plusServer(t)
	defer srv.Close()
	obs, err := Collector{}.Collect(context.Background(), contract.Target{Kind: "url", Value: srv.URL}, nil, map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	types := map[string]int{}
	byName := map[string]contract.ObservedCi{}
	for _, ci := range obs.Cis {
		types[ci.Type]++
		byName[ci.Name] = ci
	}
	// LB + zone + upstream pool + 3 members; 2 IPs (the fqdn member has none).
	if types[typeLB] != 1 || types[typeListener] != 5 || types[typeIP] != 2 {
		t.Fatalf("unexpected CI mix: %+v", types)
	}
	lb := obs.Cis[0]
	if lb.Attributes["edition"] != "plus" || lb.Attributes["version"] != "1.25.5" || lb.Attributes["activeConnections"] != int64(291) {
		t.Fatalf("load balancer wrong: %+v", lb.Attributes)
	}
	pool := byName["shop (upstream)"]
	if pool.Attributes["memberCount"] != 3 || pool.Attributes["membersUp"] != 2 {
		t.Fatalf("pool wrong: %+v", pool.Attributes)
	}
	rels := map[string]int{}
	for _, r := range obs.Relationships {
		rels[r.Type]++
		if r.Type == relDependsOn && r.To.Identity["hostRef"] == "10.191.3.22" && r.Attributes["state"] != "unhealthy" {
			t.Fatalf("member state wrong: %+v", r.Attributes)
		}
	}
	// contains: zone + pool; depends_on: zone→pool + 3 members; uses_ip: 2.
	if rels[relContains] != 2 || rels[relDependsOn] != 4 || rels[relUsesIP] != 2 {
		t.Fatalf("relationship mix wrong: %+v", rels)
	}
	if len(obs.Evidence) != 5 {
		t.Fatalf("expected 4 API bodies + stub page as evidence, got %d", len(obs.Evidence))
	}
}

func TestStubOnly(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/stub_status", func(w http.ResponseWriter, r *http.Request) {
		if u, p, ok := r.BasicAuth(); !ok || u != "status" || p != "pw" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		_, _ = w.Write([]byte(stubPage))
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte("<html><body>404 Not Found</body></html>"))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	cred := &contract.Credential{Type: "password", Fields: map[string]string{credUser: "status", credPassword: "pw"}}
	obs, err := Collector{}.Collect(context.Background(), contract.Target{Kind: "url", Value: srv.URL}, cred, map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	if len(obs.Cis) != 1 || obs.Cis[0].Attributes["edition"] != "open-source" || obs.Cis[0].Attributes["requests"] != int64(31070465) {
		t.Fatalf("stub-only emit wrong: %+v", obs.Cis)
	}
	bad := &contract.Credential{Type: "password", Fields: map[string]string{credUser: "status", credPassword: "nope"}}
	if _, err := (Collector{}).Collect(context.Background(), contract.Target{Kind: "url", Value: srv.URL}, bad, map[string]any{}); err == nil || !strings.Contains(err.Error(), contract.ErrAuthFailed) {
		t.Fatalf("expected auth_failed, got %v", err)
	}
	if _, ok := ParseStubStatus("<html>default site</html>"); ok {
		t.Fatal("html must not parse as stub_status")
	}
	if c, err := restjson.New(srv.URL, defaultPort, restjson.Auth{}, restjson.Options{}); err != nil || c.Base.Host == "" {
		t.Fatalf("client base wrong: %v", err)
	}
	_ = time.Now()
}
