// T-305 REQ-DISC-018 — replays statistics CSV recorded from real HAProxy containers (3.2 with the
// default stats page, 2.8 with `stats show-legends`) through the real Collect/Fetch/Parse/Emit path
// and checks the load balancer, frontends, backend pools, member listeners and dependency edges.
package haproxy

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
func replay(t *testing.T, dir string) *httptest.Server {
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
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
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
	return srv
}

type haproxyExpect struct {
	frontends, backends, servers int
	listeners, ips               int
	contains, dependsOn, usesIP  int
	downMember                   string // hostRef of the member recorded DOWN ("" when addresses are hidden)
	webMembersUp, webMembers     int
	webBalance, apiBalance       string // HAProxy reports algo (like addr) only with show-legends
}

var haproxyFixtures = map[string]haproxyExpect{
	// Default stats page: HAProxy leaves the addr and algo columns empty, so members stay on the pool only.
	"haproxy-haproxy-3.2.26": {frontends: 3, backends: 2, servers: 5, listeners: 5, ips: 0, contains: 5, dependsOn: 1, usesIP: 0, webMembersUp: 2, webMembers: 3, webBalance: "", apiBalance: ""},
	// `stats show-legends`: addresses present, members become listeners with IPs.
	"haproxy-haproxy-2.8.31-show-legends": {frontends: 3, backends: 2, servers: 5, listeners: 8, ips: 3, contains: 5, dependsOn: 6, usesIP: 3, downMember: "10.251.77.99", webMembersUp: 2, webMembers: 3, webBalance: "roundrobin", apiBalance: "leastconn"},
}

func TestREQDISC018_T305_RecordedVendorFixtures(t *testing.T) {
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
		want, ok := haproxyFixtures[entry.Name()]
		if !ok {
			t.Fatalf("fixture %s has no expectation row", entry.Name())
		}
		t.Run(entry.Name(), func(t *testing.T) {
			srv := replay(t, dir)
			obs, err := Collector{}.Collect(context.Background(), contract.Target{Kind: "url", Value: srv.URL}, nil, map[string]any{})
			if err != nil {
				t.Fatal(err)
			}
			types := map[string]int{}
			byPort := map[string]contract.ObservedCi{}
			identities := map[string]bool{}
			for _, ci := range obs.Cis {
				types[ci.Type]++
				key, _ := json.Marshal(ci.Identity)
				if identities[ci.Type+string(key)] {
					t.Fatalf("two CIs share one identity: %s %s", ci.Type, key)
				}
				identities[ci.Type+string(key)] = true
				if ci.Type == typeListener && ci.Identity["hostRef"] == "127.0.0.1" {
					byPort[ci.Identity["port"]] = ci
				}
			}
			if types[typeLB] != 1 || types[typeListener] != want.listeners || types[typeIP] != want.ips {
				t.Fatalf("CI mix %+v", types)
			}
			lb := obs.Cis[0]
			if lb.Type != typeLB || lb.Attributes["model"] != vendor || lb.Attributes["frontends"] != want.frontends || lb.Attributes["backends"] != want.backends || lb.Attributes["servers"] != want.servers {
				t.Fatalf("load balancer %+v", lb.Attributes)
			}
			web := byPort["be_web"]
			if web.Attributes["role"] != "backend-pool" || web.Attributes["balance"] != want.webBalance || web.Attributes["membersUp"] != want.webMembersUp || web.Attributes["memberCount"] != want.webMembers || web.Attributes["state"] != "up" {
				t.Fatalf("be_web pool %+v", web.Attributes)
			}
			members, _ := web.Attributes["members"].([]string)
			states, _ := web.Attributes["memberStates"].([]string)
			addrs, _ := web.Attributes["memberAddresses"].([]string)
			if len(members) != want.webMembers || len(states) != want.webMembers || len(addrs) != want.webMembers || members[2] != "web3" || states[2] != "web3=down" {
				t.Fatalf("be_web members %v %v %v", members, states, addrs)
			}
			api := byPort["api"]
			if api.Attributes["role"] != "backend-pool" || api.Attributes["balance"] != want.apiBalance {
				t.Fatalf("listen api pool %+v", api.Attributes)
			}
			apiFront := byPort["api"+frontendSuffix]
			if apiFront.Attributes["role"] != "frontend" || apiFront.Attributes["backend"] != "api" || apiFront.Attributes["state"] != "up" {
				t.Fatalf("listen api frontend %+v", apiFront.Attributes)
			}
			if fe := byPort["fe_web"]; fe.Attributes["role"] != "frontend" || fe.Attributes["sessionsTotal"] == int64(0) {
				t.Fatalf("fe_web frontend %+v", fe.Attributes)
			}
			rels := map[string]int{}
			for _, r := range obs.Relationships {
				rels[r.Type]++
				if r.Type == relDependsOn && r.From.Identity["port"] == r.To.Identity["port"] && r.From.Identity["hostRef"] == r.To.Identity["hostRef"] {
					t.Fatalf("self dependency %+v", r)
				}
				if want.downMember != "" && r.Type == relDependsOn && r.To.Identity["hostRef"] == want.downMember && r.Attributes["state"] != "down" {
					t.Fatalf("down member edge %+v", r.Attributes)
				}
			}
			if rels[relContains] != want.contains || rels[relDependsOn] != want.dependsOn || rels[relUsesIP] != want.usesIP {
				t.Fatalf("relationship mix %+v", rels)
			}
		})
	}
	if seen == 0 || seen != len(haproxyFixtures) {
		t.Fatalf("found %d HAProxy fixtures, expected %d", seen, len(haproxyFixtures))
	}
}
