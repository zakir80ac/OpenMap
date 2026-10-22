// T-067 REQ-DISC-018 — aXAPI v3 served by httptest: session sign-on, version facts, virtual servers, service groups,
// servers and the oper view; checks the load balancer, VIP listeners, service-group pools, members, state merging
// and the logoff, plus the auth_failed classification for a bad credential.
package a10

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

const signature = "0d3f1c2b6a"

func server(t *testing.T) (*httptest.Server, *int) {
	t.Helper()
	logoffs := 0
	mux := http.NewServeMux()
	mux.HandleFunc("/axapi/v3/auth", func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var req struct {
			Credentials struct{ Username, Password string } `json:"credentials"`
		}
		_ = json.Unmarshal(body, &req)
		if req.Credentials.Username != "svc-openmap" || req.Credentials.Password != "pw" {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"response":{"status":"fail","err":{"code":520486915,"msg":"Invalid username or password"}}}`))
			return
		}
		_, _ = w.Write([]byte(`{"authresponse":{"signature":"` + signature + `","description":"the signature should be set in Authorization header for following request."}}`))
	})
	authed := func(next func(w http.ResponseWriter)) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			if r.Header.Get("Authorization") != "A10 "+signature {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			next(w)
		}
	}
	mux.HandleFunc("/axapi/v3/version/oper", authed(func(w http.ResponseWriter) {
		_, _ = w.Write([]byte(`{"version":{"oper":{"hw-platform":"Thunder 3030S","sw-version":"5.2.1-p8 build 112","serial-number":"TH30A12345678","hostname":"lb-dmz-01","ha-state":"Active","up-time":"41 days"}}}`))
	}))
	mux.HandleFunc("/axapi/v3/slb/virtual-server", authed(func(w http.ResponseWriter) {
		_, _ = w.Write([]byte(`{"virtual-server-list":[{"name":"vip-portal","ip-address":"10.191.9.10","enable-disable-action":"enable","port-list":[{"port-number":443,"protocol":"https","service-group":"sg-portal","action":"enable"},{"port-number":80,"protocol":"http","service-group":"sg-portal","action":"disable"}]}]}`))
	}))
	mux.HandleFunc("/axapi/v3/slb/service-group", authed(func(w http.ResponseWriter) {
		_, _ = w.Write([]byte(`{"service-group-list":[{"name":"sg-portal","protocol":"tcp","lb-method":"least-connection","health-check":"hm-https","member-list":[{"name":"web01","port":8443,"member-state":"enable","member-priority":1},{"name":"web02","port":8443,"member-state":"enable","member-priority":1},{"name":"web-dr","port":8443,"member-state":"disable","member-priority":1}]}]}`))
	}))
	mux.HandleFunc("/axapi/v3/slb/server", authed(func(w http.ResponseWriter) {
		_, _ = w.Write([]byte(`{"server-list":[{"name":"web01","host":"10.191.3.31","action":"enable"},{"name":"web02","host":"10.191.3.32","action":"enable"},{"name":"web-dr","fqdn-name":"web-dr.dr.example.internal","action":"enable"}]}`))
	}))
	mux.HandleFunc("/axapi/v3/slb/service-group/oper", authed(func(w http.ResponseWriter) {
		_, _ = w.Write([]byte(`{"service-group-list":[{"name":"sg-portal","oper":{"state":"Functional Up"},"member-list":[{"member-name":"web01","port":8443,"oper":{"state":"Up"}},{"member-name":"web02","port":8443,"oper":{"state":"Down"}},{"member-name":"web-dr","port":8443,"oper":{"state":"Disabled"}}]}]}`))
	}))
	mux.HandleFunc("/axapi/v3/logoff", authed(func(w http.ResponseWriter) {
		logoffs++
		_, _ = w.Write([]byte(`{"response":{"status":"OK"}}`))
	}))
	return httptest.NewTLSServer(mux), &logoffs
}

func TestWalkAndEmit(t *testing.T) {
	srv, logoffs := server(t)
	defer srv.Close()
	cred := &contract.Credential{Type: "password", Fields: map[string]string{credUser: "svc-openmap", credPassword: "pw"}}
	target := contract.Target{Kind: "host", Value: strings.TrimPrefix(srv.URL, "https://")}
	obs, err := Collector{}.Collect(context.Background(), target, cred, map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	types := map[string]int{}
	byName := map[string]contract.ObservedCi{}
	for _, ci := range obs.Cis {
		types[ci.Type]++
		byName[ci.Name] = ci
	}
	// LB; listeners: 1 pool + 3 members + 2 VIP ports = 6; IPs: 2 member addresses + 1 VIP (deduplicated per port? the VIP ip repeats per port → 2 entries).
	if types[typeLB] != 1 || types[typeListener] != 6 || types[typeIP] != 4 {
		t.Fatalf("unexpected CI mix: %+v", types)
	}
	lb := obs.Cis[0]
	if lb.Identity["serialNumber"] != "TH30A12345678" || lb.Attributes["model"] != "Thunder 3030S" || lb.Attributes["haState"] != "Active" || lb.Name != "lb-dmz-01" {
		t.Fatalf("load balancer wrong: %+v", lb)
	}
	pool := byName["sg-portal (service group)"]
	if pool.Attributes["loadBalancingMode"] != "least-connection" || pool.Attributes["memberCount"] != 3 || pool.Attributes["membersUp"] != 1 || pool.Attributes["state"] != "up" {
		t.Fatalf("pool wrong: %+v", pool.Attributes)
	}
	vip := byName["vip-portal (10.191.9.10:443)"]
	if vip.Attributes["enabled"] != true || vip.Attributes["serviceGroup"] != "sg-portal" || vip.Identity["protocol"] != "https" {
		t.Fatalf("vip wrong: %+v", vip)
	}
	if byName["vip-portal (10.191.9.10:80)"].Attributes["enabled"] != false {
		t.Fatal("disabled port must be reported disabled")
	}
	rels := map[string]int{}
	for _, r := range obs.Relationships {
		rels[r.Type]++
		if r.Type == relDependsOn && r.To.Identity["hostRef"] == "10.191.3.32" && r.Attributes["state"] != "down" {
			t.Fatalf("oper state must win: %+v", r.Attributes)
		}
		if r.Type == relDependsOn && r.To.Identity["hostRef"] == "web-dr.dr.example.internal" && r.Attributes["state"] != "disabled" {
			t.Fatalf("disabled member wrong: %+v", r.Attributes)
		}
	}
	// contains: pool + 2 VIP ports; depends_on: 3 members + 2 VIP→pool; uses_ip: 2 members + 2 VIPs; runs_on: fqdn member.
	if rels[relContains] != 3 || rels[relDependsOn] != 5 || rels[relUsesIP] != 4 || rels[relRunsOn] != 1 {
		t.Fatalf("relationship mix wrong: %+v", rels)
	}
	if *logoffs != 1 {
		t.Fatalf("expected one logoff, got %d", *logoffs)
	}
	if len(obs.Evidence) < 5 {
		t.Fatalf("expected the API bodies as evidence, got %d", len(obs.Evidence))
	}
}

func TestBadCredential(t *testing.T) {
	srv, _ := server(t)
	defer srv.Close()
	cred := &contract.Credential{Type: "password", Fields: map[string]string{credUser: "svc-openmap", credPassword: "wrong"}}
	_, err := Collector{}.Collect(context.Background(), contract.Target{Kind: "host", Value: strings.TrimPrefix(srv.URL, "https://")}, cred, map[string]any{})
	if err == nil || !strings.Contains(err.Error(), contract.ErrAuthFailed) {
		t.Fatalf("expected auth_failed, got %v", err)
	}
}
