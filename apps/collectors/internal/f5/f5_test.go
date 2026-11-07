// T-058 REQ-DISC-018 — serves iControl REST-shaped device, virtual, pool and node collections from
// httptest and checks load balancer, VIP listener, member listener and dependency emission.
package f5

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
	docs := map[string]any{
		"/mgmt/tm/cm/device":   map[string]any{"items": []any{map[string]any{"hostname": "bigip-ryd-01.corp.example", "managementIp": "10.190.0.11", "marketingName": "BIG-IP i5800", "platformId": "C119", "chassisId": "f5-abcd-1234", "version": "17.1.1", "build": "0.2.6", "edition": "Point Release 2", "failoverState": "active", "baseMac": "00:94:A1:AA:BB:00", "selfDevice": "true", "activeModules": []string{"LTM, i5800", "ASM"}}}},
		"/mgmt/tm/ltm/virtual": map[string]any{"items": []any{map[string]any{"name": "vs_web_443", "partition": "Common", "fullPath": "/Common/vs_web_443", "destination": "/Common/10.191.1.10:443", "ipProtocol": "tcp", "pool": "/Common/pool_web", "enabled": true, "rules": []string{"/Common/redirect"}, "profilesReference": map[string]any{"items": []any{map[string]string{"name": "clientssl"}, map[string]string{"name": "http"}}}}}},
		"/mgmt/tm/ltm/pool": map[string]any{"items": []any{map[string]any{"name": "pool_web", "fullPath": "/Common/pool_web", "loadBalancingMode": "least-connections-member", "monitor": "/Common/https", "membersReference": map[string]any{"items": []any{
			map[string]any{"name": "web01:8443", "address": "10.191.2.11", "state": "up", "session": "monitor-enabled", "ratio": 1},
			map[string]any{"name": "web02:8443", "address": "10.191.2.12", "state": "down", "session": "monitor-enabled", "ratio": 1},
		}}}}},
		"/mgmt/tm/ltm/node": map[string]any{"items": []any{map[string]any{"name": "web01", "address": "10.191.2.11", "state": "up", "fqdn": map[string]string{"tmName": "web01.corp.example"}}, map[string]any{"name": "web02", "address": "10.191.2.12", "state": "down"}}},
	}
	return httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/mgmt/shared/authn/login" {
			_ = json.NewEncoder(w).Encode(map[string]any{"token": map[string]string{"token": "tok-1"}})
			return
		}
		u, p, ok := r.BasicAuth()
		if (!ok || u != "admin" || p != "pw") && r.Header.Get(tokenHeader) != "tok-1" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		doc, found := docs[r.URL.Path]
		if !found {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(doc)
	}))
}

func TestWalkAndEmit(t *testing.T) {
	srv := server(t)
	defer srv.Close()
	c, _ := restjson.New(srv.URL, defaultPort, restjson.Auth{User: "admin", Pass: "pw"}, restjson.Options{})
	inv, err := Walk(context.Background(), c)
	if err != nil {
		t.Fatal(err)
	}
	obs := Emit(inv, contract.Target{Kind: "host", Value: "10.190.0.11"}, time.Now())
	types := map[string]int{}
	for _, ci := range obs.Cis {
		types[ci.Type]++
	}
	if types[typeLB] != 1 || types[typeListener] != 3 || types[typeIP] != 3 {
		t.Fatalf("unexpected CI mix: %+v", types)
	}
	lb := obs.Cis[0]
	if lb.Identity["serialNumber"] != "f5-abcd-1234" || lb.Attributes["failoverState"] != "active" || lb.Attributes["virtualServersEnabled"] != 1 {
		t.Fatalf("load balancer wrong: %+v", lb)
	}
	vs := obs.Cis[1]
	if vs.Identity["hostRef"] != "bigip-ryd-01.corp.example" || vs.Identity["port"] != "/Common/vs_web_443:443" || vs.Attributes["membersUp"] != 1 || vs.Attributes["destination"] != "10.191.1.10" {
		t.Fatalf("virtual server wrong: %+v", vs)
	}
	rels := map[string]int{}
	runsOnFqdn := ""
	for _, r := range obs.Relationships {
		rels[r.Type]++
		if r.Type == relRunsOn {
			runsOnFqdn = r.To.Identity["fqdn"]
		}
	}
	if rels[relContains] != 1 || rels[relUsesIP] != 3 || rels[relDependsOn] != 2 || rels[relRunsOn] != 1 || runsOnFqdn != "web01.corp.example" {
		t.Fatalf("relationship mix wrong: %+v (%s)", rels, runsOnFqdn)
	}
}

func TestTokenLogin(t *testing.T) {
	srv := server(t)
	defer srv.Close()
	c, _ := restjson.New(srv.URL, defaultPort, restjson.Auth{}, restjson.Options{})
	tok, err := Login(context.Background(), c, "admin", "pw")
	if err != nil || tok != "tok-1" {
		t.Fatalf("login failed: %v %q", err, tok)
	}
}

func TestSplitDestination(t *testing.T) {
	if a, p := SplitDestination("/Common/10.1.1.10:443"); a != "10.1.1.10" || p != 443 {
		t.Fatalf("ipv4 split wrong: %s %d", a, p)
	}
	if a, p := SplitDestination("/Common/10.1.1.10%2:80"); a != "10.1.1.10" || p != 80 {
		t.Fatalf("route domain split wrong: %s %d", a, p)
	}
	if a, p := SplitDestination("/Common/2001:db8::10.443"); a != "2001:db8::10" || p != 443 {
		t.Fatalf("ipv6 split wrong: %s %d", a, p)
	}
	if !strings.HasPrefix(firstNonEmpty("", "x"), "x") {
		t.Fatal("firstNonEmpty failed")
	}
}
