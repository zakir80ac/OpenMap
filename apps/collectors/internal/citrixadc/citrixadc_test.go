// T-065 REQ-DISC-018 — serves NITRO-shaped responses from httptest and checks appliance facts,
// lbvserver listeners with VIPs, service-group members and the content-switching dependency.
package citrixadc

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

var responses = map[string]string{
	"nshostname":                            `{"errorcode":0,"message":"Done","severity":"NONE","nshostname":[{"hostname":"ns-lab-01"}]}`,
	"nsversion":                             `{"errorcode":0,"message":"Done","nsversion":{"version":"NetScaler NS13.1: Build 49.13.nc, Date: Jul 20 2023","mode":"1"}}`,
	"nshardware":                            `{"errorcode":0,"message":"Done","nshardware":{"hwdescription":"NetScaler Virtual Appliance","sysid":"450000","serialno":"HE2H81UJ47","host":"4e6f7465"}}`,
	"nsip":                                  `{"errorcode":0,"message":"Done","nsip":[{"ipaddress":"10.191.9.5","type":"NSIP"},{"ipaddress":"10.191.9.6","type":"SNIP"}]}`,
	"hanode":                                `{"errorcode":0,"message":"Done","hanode":[{"id":"0","ipaddress":"10.191.9.5","state":"Primary","hastatus":"UP"},{"id":"1","ipaddress":"10.191.9.7","state":"Secondary","hastatus":"UP"}]}`,
	"lbvserver":                             `{"errorcode":0,"message":"Done","lbvserver":[{"name":"lb_web","ipv46":"10.191.20.10","port":443,"servicetype":"SSL","curstate":"UP","effectivestate":"UP","lbmethod":"LEASTCONNECTION","persistencetype":"SOURCEIP","health":"50"},{"name":"lb_dns","ipv46":"10.191.20.53","port":53,"servicetype":"DNS","curstate":"DOWN","effectivestate":"DOWN","lbmethod":"ROUNDROBIN","persistencetype":"NONE","health":"0"}]}`,
	"lbvserver_service_binding/lb_dns":      `{"errorcode":0,"message":"Done","lbvserver_service_binding":[{"servicename":"svc_dns1","ipv46":"10.191.3.53","port":53,"curstate":"DOWN","weight":"1","servicetype":"DNS"}]}`,
	"lbvserver_servicegroup_binding/lb_web": `{"errorcode":0,"message":"Done","lbvserver_servicegroup_binding":[{"servicegroupname":"sg_web"}]}`,
	"servicegroup_servicegroupmember_binding/sg_web": `{"errorcode":0,"message":"Done","servicegroup_servicegroupmember_binding":[{"ip":"10.191.3.11","port":8443,"svrstate":"UP","weight":"1","servername":"web01"},{"ip":"10.191.3.12","port":8443,"svrstate":"OUT OF SERVICE","weight":"1","servername":"web02"}]}`,
	"csvserver":                          `{"errorcode":0,"message":"Done","csvserver":[{"name":"cs_edge","ipv46":"10.191.20.1","port":443,"servicetype":"SSL","curstate":"UP"}]}`,
	"csvserver_cspolicy_binding/cs_edge": `{"errorcode":0,"message":"Done","csvserver_cspolicy_binding":[{"policyname":"pol_web","targetlbvserver":"lb_web"}]}`,
}

func server(t *testing.T) *httptest.Server {
	t.Helper()
	return httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get(headerUser) != "nsroot" || r.Header.Get(headerPass) != "secret" {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"errorcode":354,"message":"Invalid username or password","severity":"ERROR"}`))
			return
		}
		object := strings.TrimPrefix(r.URL.Path, nitroConfig)
		body, ok := responses[object]
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"errorcode":258,"message":"No such resource","severity":"ERROR"}`))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(body))
	}))
}

func TestWalkAndEmit(t *testing.T) {
	srv := server(t)
	defer srv.Close()
	c, err := restjson.New(srv.URL, defaultPort, restjson.Auth{}, restjson.Options{Headers: map[string]string{headerUser: "nsroot", headerPass: "secret"}})
	if err != nil {
		t.Fatal(err)
	}
	inv, err := Walk(context.Background(), c)
	if err != nil {
		t.Fatal(err)
	}
	if inv.Hostname != "ns-lab-01" || inv.Serial != "HE2H81UJ47" || len(inv.NSIPs) != 1 || inv.HAState != "Primary" || inv.HANodes != 2 {
		t.Fatalf("facts wrong: %+v", inv)
	}
	if len(inv.Members["lb_web"]) != 2 || len(inv.Members["lb_dns"]) != 1 || inv.CSTargets["cs_edge"][0] != "lb_web" {
		t.Fatalf("bindings wrong: %+v %+v", inv.Members, inv.CSTargets)
	}
	obs := Emit(inv, contract.Target{Kind: "host", Value: "10.191.9.5"}, time.Now())
	types := map[string]int{}
	for _, ci := range obs.Cis {
		types[ci.Type]++
	}
	// lb_web, lb_dns, cs_edge + 3 members; VIPs 3 + member IPs 3
	if types[typeLB] != 1 || types[typeListener] != 6 || types[typeIP] != 6 {
		t.Fatalf("unexpected CI mix: %+v", types)
	}
	lb := obs.Cis[0]
	if lb.Identity["serialNumber"] != "HE2H81UJ47" || lb.Identity["managementIp"] != "10.191.9.5" || lb.Attributes["haState"] != "primary" || lb.Attributes["virtualServersUp"] != 1 {
		t.Fatalf("load balancer wrong: %+v", lb)
	}
	var web, dns, edge contract.ObservedCi
	for _, ci := range obs.Cis {
		switch ci.Attributes["virtualServer"] {
		case "lb_web":
			if ci.Type == typeListener {
				web = ci
			}
		case "lb_dns":
			if ci.Type == typeListener {
				dns = ci
			}
		case "cs_edge":
			if ci.Type == typeListener {
				edge = ci
			}
		}
	}
	if web.Identity["port"] != "lb_web:443" || web.Identity["protocol"] != "tcp" || web.Attributes["membersUp"] != 1 || web.Attributes["memberCount"] != 2 || web.Attributes["loadBalancingMode"] != "LEASTCONNECTION" || web.Attributes["healthPercent"] != 50 {
		t.Fatalf("lb_web wrong: %+v", web)
	}
	if dns.Identity["protocol"] != "udp" || dns.Attributes["state"] != "down" {
		t.Fatalf("lb_dns wrong: %+v", dns)
	}
	if edge.Attributes["role"] != "content-switching" {
		t.Fatalf("cs_edge wrong: %+v", edge)
	}
	rels := map[string]int{}
	csLinked := false
	for _, r := range obs.Relationships {
		rels[r.Type]++
		if r.Type == relDependsOn && r.From.Identity["port"] == "cs/cs_edge:443" && r.To.Identity["hostRef"] == "ns-lab-01" {
			csLinked = true
		}
		if r.Type == relDependsOn && r.To.Identity["hostRef"] == "10.191.3.12" && r.Attributes["state"] != "disabled" {
			t.Fatalf("member state wrong: %+v", r.Attributes)
		}
	}
	// contains 3; depends_on: 2 web members + 1 dns member + cs→lb; uses_ip 6
	if rels[relContains] != 3 || rels[relDependsOn] != 4 || rels[relUsesIP] != 6 || !csLinked {
		t.Fatalf("relationship mix wrong: %+v linked=%v", rels, csLinked)
	}
	if len(obs.Evidence) == 0 {
		t.Fatal("expected raw evidence")
	}
}

func TestBadCredential(t *testing.T) {
	srv := server(t)
	defer srv.Close()
	c, _ := restjson.New(srv.URL, defaultPort, restjson.Auth{}, restjson.Options{Headers: map[string]string{headerUser: "nsroot", headerPass: "wrong"}})
	_, err := Walk(context.Background(), c)
	if err == nil || !strings.Contains(err.Error(), contract.ErrAuthFailed) {
		t.Fatalf("expected auth_failed, got %v", err)
	}
	if err := checkEnvelope("ns", envelope{ErrorCode: nitroErrBadCredential, Message: "bad"}); err == nil || !strings.Contains(err.Error(), contract.ErrAuthFailed) {
		t.Fatalf("envelope classification wrong: %v", err)
	}
}
