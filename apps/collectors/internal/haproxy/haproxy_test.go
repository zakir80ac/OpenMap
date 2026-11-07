// T-064 REQ-DISC-018 — parses an HAProxy 2.x statistics CSV served by httptest and checks the load
// balancer, frontend listener, member listeners and dependency edges.
package haproxy

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

const statsCsv = `# pxname,svname,qcur,qmax,scur,smax,slim,stot,bin,bout,dreq,dresp,ereq,econ,eresp,wretr,wredis,status,weight,act,bck,chkfail,chkdown,lastchg,downtime,qlimit,pid,iid,sid,throttle,lbtot,tracked,type,rate,rate_lim,rate_max,check_status,check_code,check_duration,hrsp_1xx,hrsp_2xx,hrsp_3xx,hrsp_4xx,hrsp_5xx,hrsp_other,hanafail,req_rate,req_rate_max,req_tot,cli_abrt,srv_abrt,comp_in,comp_out,comp_byp,comp_rsp,lastsess,last_chk,last_agt,qtime,ctime,rtime,ttime,agent_status,agent_code,agent_duration,check_desc,agent_desc,check_rise,check_fall,check_health,agent_rise,agent_fall,agent_health,addr,cookie,mode,algo,conn_rate,conn_rate_max,conn_tot,intercepted,dcon,dses,
web_front,FRONTEND,,,12,80,2000,91234,123456789,987654321,0,0,3,,,,,OPEN,,,,,,,,,1,2,0,,,,0,5,0,40,,,,0,80000,900,300,20,0,,5,60,91000,,,0,0,0,0,,,,,,,,,,,,,,,,,,,,http,,5,60,91234,0,0,0,
web_back,web01,0,0,4,30,,45000,60000000,500000000,,0,,0,0,1,0,UP,10,1,0,2,1,86400,0,,1,3,1,,45000,,2,2,,20,L7OK,200,3,0,40000,450,150,10,0,0,,,,0,0,0,0,0,0,10,"OK",,0,1,5,10,,,,Layer7 check passed,,2,3,4,,,,10.191.3.11:8080,,http,roundrobin,,,,,,,
web_back,web02,0,0,0,0,,0,0,0,,0,,0,0,0,0,DOWN,10,1,0,5,2,120,3600,,1,3,2,,0,,2,0,,0,L4CON,,2,0,0,0,0,0,0,0,,,,0,0,0,0,0,0,-1,"Connection refused",,0,0,0,0,,,,Layer4 connection problem,,2,3,0,,,,10.191.3.12:8080,,http,roundrobin,,,,,,,
web_back,BACKEND,0,0,4,30,200,45000,60000000,500000000,0,0,,0,0,1,0,UP,10,1,0,,2,86400,3600,,1,3,0,,45000,,1,2,,20,,,,0,40000,450,150,10,0,,,,45000,0,0,0,0,0,0,10,,,0,1,5,10,,,,,,,,,,,,,,http,roundrobin,,,,,,,
`

func TestParseAndEmit(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if u, p, ok := r.BasicAuth(); !ok || u != "stats" || p != "pw" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if !strings.HasPrefix(r.URL.Path, "/stats") || !strings.Contains(r.RequestURI, ";csv") {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Header().Set("Server", "haproxy 2.8.5")
		_, _ = w.Write([]byte(statsCsv))
	}))
	defer srv.Close()
	body, server, err := Fetch(context.Background(), srv.URL, defaultPath, "stats", "pw", false, "")
	if err != nil {
		t.Fatal(err)
	}
	rows, err := Parse(string(body))
	if err != nil || len(rows) != 4 {
		t.Fatalf("parse wrong: %v %d", err, len(rows))
	}
	obs := Emit(rows, contract.Target{Kind: "url", Value: srv.URL}, server, body, time.Now())
	types := map[string]int{}
	for _, ci := range obs.Cis {
		types[ci.Type]++
	}
	if types[typeLB] != 1 || types[typeListener] != 4 || types[typeIP] != 2 {
		t.Fatalf("unexpected CI mix: %+v", types)
	}
	if obs.Cis[0].Attributes["model"] != "haproxy 2.8.5" || obs.Cis[0].Attributes["frontends"] != 1 || obs.Cis[0].Attributes["servers"] != 2 {
		t.Fatalf("load balancer wrong: %+v", obs.Cis[0].Attributes)
	}
	byPort := map[string]contract.ObservedCi{}
	for _, ci := range obs.Cis {
		if ci.Type == typeListener && ci.Identity["hostRef"] != "127.0.0.1" {
			continue
		}
		byPort[ci.Identity["port"]] = ci
	}
	pool := byPort["web_back"]
	if pool.Attributes["balance"] != "roundrobin" || pool.Attributes["membersUp"] != 1 || pool.Attributes["memberCount"] != 2 || pool.Attributes["state"] != "up" {
		t.Fatalf("backend wrong: %+v", pool.Attributes)
	}
	front := byPort["web_front"]
	if front.Attributes["backend"] != "web_back" || front.Attributes["state"] != "up" || front.Attributes["role"] != "frontend" {
		t.Fatalf("frontend wrong: %+v", front.Attributes)
	}
	rels := map[string]int{}
	for _, r := range obs.Relationships {
		rels[r.Type]++
		if r.Type == relDependsOn && r.To.Identity["hostRef"] == "10.191.3.12" && r.Attributes["state"] != "down" {
			t.Fatalf("member state wrong: %+v", r.Attributes)
		}
	}
	if rels[relContains] != 2 || rels[relDependsOn] != 3 || rels[relUsesIP] != 2 {
		t.Fatalf("relationship mix wrong: %+v", rels)
	}
	if _, _, err := Fetch(context.Background(), srv.URL, defaultPath, "stats", "wrong", false, ""); err == nil || !strings.Contains(err.Error(), contract.ErrAuthFailed) {
		t.Fatalf("expected auth_failed, got %v", err)
	}
}
