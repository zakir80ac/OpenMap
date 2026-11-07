// REQ-QA-005 REQ-DISC-018 — simulated HAProxy statistics page (`stats uri /stats`, `;csv` export). The CSV
// follows the HAProxy 2.8 column layout recorded from a real container (packages/testing/fixtures/vendor/
// load_balancer/haproxy-haproxy-2.8.31-show-legends): the same header, FRONTEND / server / BACKEND rows,
// type codes and status words; with `stats show-legends` the addr and algo columns are filled, without it
// they stay empty, as HAProxy does.
//
// The synthetic estate holds no HAProxy, so this simulator GENERATES a deterministic keepalived pair (named
// <site>-haproxy-01/02) at the first site with Patroni PostgreSQL clusters, in the classic Patroni layout:
// one `listen` section per Patroni cluster (mode tcp, the estate database VMs on their estate listening
// services and addresses, health-checked against the Patroni REST API so only the estate's primaryNode is
// UP and the replicas report DOWN with L7STS) plus one `listen` section per TCP infrastructure service of
// the site, and the `stats` frontend itself. Unit 01 serves HTTPS under the simulated CA with `stats auth`
// and show-legends; unit 02 serves the default page in clear text without auth, so both collector paths
// run. Counters are hashed from the proxy and server names. Expectations come from this same generated set.
package haproxy

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/csv"
	"net/http"
	"strconv"
	"strings"

	"github.com/openmap/openmap/tools/simulator/internal/estate"
	"github.com/openmap/openmap/tools/simulator/internal/sim"
	"github.com/openmap/openmap/tools/simulator/internal/vendors/lbestate"
)

// header is the HAProxy 2.8 `show stat` column list (the recorded 2.8.31 capture's header line).
const header = "pxname,svname,qcur,qmax,scur,smax,slim,stot,bin,bout,dreq,dresp,ereq,econ,eresp,wretr,wredis,status,weight,act,bck,chkfail,chkdown,lastchg,downtime,qlimit,pid,iid,sid,throttle,lbtot,tracked,type,rate,rate_lim,rate_max,check_status,check_code,check_duration,hrsp_1xx,hrsp_2xx,hrsp_3xx,hrsp_4xx,hrsp_5xx,hrsp_other,hanafail,req_rate,req_rate_max,req_tot,cli_abrt,srv_abrt,comp_in,comp_out,comp_byp,comp_rsp,lastsess,last_chk,last_agt,qtime,ctime,rtime,ttime,agent_status,agent_code,agent_duration,check_desc,agent_desc,check_rise,check_fall,check_health,agent_rise,agent_fall,agent_health,addr,cookie,mode,algo,conn_rate,conn_rate_max,conn_tot,intercepted,dcon,dses,wrew,connect,reuse,cache_lookups,cache_hits,srv_icur,src_ilim,qtime_max,ctime_max,rtime_max,ttime_max,eint,idle_conn_cur,safe_conn_cur,used_conn_cur,need_conn_est,uweight,agg_server_status,agg_server_check_status,agg_check_status,srid,sess_other,h1sess,h2sess,h3sess,req_other,h1req,h2req,h3req,proto,-,ssl_sess,ssl_reused_sess,ssl_failed_handshake,h2_headers_rcvd,h2_data_rcvd,h2_settings_rcvd,h2_rst_stream_rcvd,h2_goaway_rcvd,h2_detected_conn_protocol_errors,h2_detected_strm_protocol_errors,h2_rst_stream_resp,h2_goaway_resp,h2_open_connections,h2_backend_open_streams,h2_total_connections,h2_backend_total_streams,h1_open_connections,h1_open_streams,h1_total_connections,h1_total_streams,h1_bytes_in,h1_bytes_out,h1_spliced_bytes_in,h1_spliced_bytes_out,"

const (
	statsPath    = "/stats;csv"
	tierDB       = "db"
	tierInfra    = "infra"
	protoTCP     = "tcp"
	haPatroni    = "patroni"
	relBackedBy  = "backed_by"
	statsProxy   = "stats"
	svFrontend   = "FRONTEND"
	svBackend    = "BACKEND"
	typeFrontend = "0"
	typeBackend  = "1"
	typeServer   = "2"
	sessionLimit = "524261"
	backendLimit = "52427"
	pairSize     = 2
	nameSuffix   = "-haproxy-0"
	// counterSpan bounds the hashed session and byte counters.
	counterSpan  = 100000
	bytesPerSess = 820
	checkRise    = "2"
	checkFall    = "3"
)

type Vendor struct{}

func (Vendor) ID() string             { return "haproxy" }
func (Vendor) Collector() string      { return "haproxy" }
func (Vendor) Requirements() []string { return []string{"REQ-DISC-018"} }

func patroni(e *estate.Estate, comp *estate.CI) *estate.CI {
	for _, c := range e.From(comp, relBackedBy) {
		if c.Str("haMode") == haPatroni {
			return c
		}
	}
	return nil
}

func frontedBy(e *estate.Estate) func(_, comp *estate.CI) bool {
	return func(_, comp *estate.CI) bool {
		switch comp.Str("tier") {
		case tierDB:
			return patroni(e, comp) != nil
		case tierInfra:
			return comp.Str("protocol") == protoTCP
		}
		return false
	}
}

// section is one `listen` section: a frontend and a backend under one proxy name.
type section struct {
	pool    lbestate.Pool
	primary string // Patroni primaryNode ("" for infrastructure services)
}

func (s section) up(m lbestate.Member) bool {
	if s.primary != "" {
		return m.Host == s.primary && m.Up()
	}
	return m.Up()
}

type unit struct {
	name     string
	legends  bool
	secure   bool
	sections []section
}

func plan(e *estate.Estate) []*unit {
	keep := frontedBy(e)
	var site string
	for _, s := range lbestate.Sites(e, keep) {
		for _, p := range lbestate.Pools(e, s, keep) {
			if p.Tier == tierDB {
				site = s
				break
			}
		}
		if site != "" {
			break
		}
	}
	if site == "" {
		return nil
	}
	var sections []section
	for _, p := range lbestate.Pools(e, site, keep) {
		s := section{pool: p}
		if c := patroni(e, p.Component); c != nil {
			s.primary = c.Str("primaryNode")
		}
		sections = append(sections, s)
	}
	prefix := strings.ToLower(strings.SplitN(site, "-", pairSize)[0])
	var units []*unit
	for i := 0; i < pairSize; i++ {
		units = append(units, &unit{name: prefix + nameSuffix + strconv.Itoa(i+1), legends: i == 0, secure: i == 0, sections: sections})
	}
	return units
}

func counter(parts ...string) int64 {
	sum := sha256.Sum256([]byte(strings.Join(parts, "/")))
	return int64(binary.BigEndian.Uint64(sum[:8]) % counterSpan)
}

func (u *unit) csv() []byte {
	cols := strings.Split(strings.TrimSuffix(header, ","), ",")
	index := map[string]int{}
	for i, c := range cols {
		index[c] = i
	}
	var buf bytes.Buffer
	buf.WriteString("# " + header + "\n")
	w := csv.NewWriter(&buf)
	row := func(fields map[string]string) {
		rec := make([]string, len(cols)+1) // the header's trailing comma adds one empty column
		for k, v := range fields {
			if i, ok := index[k]; ok {
				rec[i] = v
			}
		}
		_ = w.Write(rec)
	}
	itoa := func(n int64) string { return strconv.FormatInt(n, 10) }
	iid := 1
	row(map[string]string{"pxname": statsProxy, "svname": svFrontend, "scur": "1", "smax": "1", "slim": sessionLimit, "stot": "1", "status": "OPEN", "pid": "1", "iid": strconv.Itoa(iid), "sid": "0", "type": typeFrontend, "mode": "http"})
	for _, s := range u.sections {
		iid++
		px := s.pool.Name
		mode := protoTCP
		total := counter(u.name, px)
		row(map[string]string{"pxname": px, "svname": svFrontend, "scur": "0", "smax": "4", "slim": sessionLimit, "stot": itoa(total), "bin": itoa(total * bytesPerSess), "bout": itoa(total * bytesPerSess), "status": "OPEN", "pid": "1", "iid": strconv.Itoa(iid), "sid": "0", "type": typeFrontend, "mode": mode})
		up, active := 0, 0
		for sid, m := range s.pool.Members {
			st, check, desc := "UP", "L4OK", "Layer4 check passed"
			if s.primary != "" {
				check, desc = "L7OK", "Layer7 check passed"
			}
			if !s.up(m) {
				st, check, desc = "DOWN", "L4TOUT", "Layer4 timeout"
				if s.primary != "" && m.Up() {
					check, desc = "L7STS", "Layer7 wrong status"
				}
			} else {
				up++
			}
			active++
			fields := map[string]string{"pxname": px, "svname": m.Host, "scur": "0", "smax": "2", "stot": itoa(counter(u.name, px, m.Host)), "status": st, "weight": "1", "act": "1", "bck": "0",
				"pid": "1", "iid": strconv.Itoa(iid), "sid": strconv.Itoa(sid + 1), "type": typeServer, "check_status": check, "check_desc": desc, "check_rise": checkRise, "check_fall": checkFall, "mode": mode}
			if st == "DOWN" {
				fields["chkfail"], fields["chkdown"], fields["downtime"] = "1", "1", itoa(counter(u.name, px, m.Host, "down"))
			}
			if u.legends {
				fields["addr"] = lbestate.Endpoint(m.Address, m.Port)
			}
			row(fields)
		}
		status := "UP"
		if up == 0 {
			status = "DOWN"
		}
		be := map[string]string{"pxname": px, "svname": svBackend, "scur": "0", "smax": "2", "slim": backendLimit, "stot": itoa(total), "bin": itoa(total * bytesPerSess), "bout": itoa(total * bytesPerSess), "status": status,
			"weight": strconv.Itoa(up), "act": strconv.Itoa(up), "bck": "0", "pid": "1", "iid": strconv.Itoa(iid), "sid": "0", "type": typeBackend, "mode": mode, "uweight": strconv.Itoa(active)}
		if u.legends {
			be["algo"] = "roundrobin"
		}
		row(be)
	}
	w.Flush()
	return buf.Bytes()
}

func (u *unit) handler(env *sim.Env) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.RequestURI() != statsPath {
			sim.WriteRaw(w, http.StatusNotFound, "text/html", []byte("<html><body><h1>404 Not Found</h1></body></html>\n"))
			return
		}
		if u.secure && !env.BasicOK(r) {
			w.Header().Set("WWW-Authenticate", `Basic realm="HAProxy Statistics"`)
			sim.WriteRaw(w, http.StatusUnauthorized, "text/html", []byte("<html><body><h1>401 Unauthorized</h1></body></html>\n"))
			return
		}
		sim.WriteRaw(w, http.StatusOK, "text/plain", u.csv())
	})
}

func (Vendor) Start(_ context.Context, e *estate.Estate, env *sim.Env) (*sim.Endpoint, error) {
	group := &sim.Endpoint{Host: sim.AdvertiseHost(), State: map[string]any{}, Devices: map[string]string{}}
	for _, u := range plan(e) {
		var ep *sim.Endpoint
		var err error
		if u.secure {
			ep, _, err = sim.ServeHTTPS(env, u.handler(env))
		} else {
			ep, _, err = sim.ServeHTTP(env, u.handler(env))
		}
		if err != nil {
			_ = group.Close()
			return nil, err
		}
		group.Devices[u.name] = ep.URL
		// The harness samples one request log: the first (authenticated, show-legends) unit's.
		if group.State["log"] == nil {
			group.State["log"] = ep.State["log"]
		}
		group.OnClose(ep.Close)
	}
	return group, nil
}

func (Vendor) Runs(e *estate.Estate, ep *sim.Endpoint, env *sim.Env) []sim.Run {
	var runs []sim.Run
	for _, u := range plan(e) {
		run := sim.Run{Name: u.name, Targets: []sim.Target{{Kind: "url", Value: ep.Devices[u.name], Label: u.name}}, Options: map[string]any{}, CredentialType: "none"}
		if u.secure {
			run.Options = map[string]any{"verifyTls": true, "caCertPem": env.CA.PEM}
			run.CredentialType = "password"
			run.Credential = &sim.Credential{Type: "password", Fields: map[string]string{"username": env.User, "password": env.Secret}}
		}
		ex := lbestate.NewExpect(&run.Expect)
		// The stats page carries no host name: the collector keys the load balancer on the target host,
		// which is the simulator's advertised host.
		lb := sim.AdvertiseHost()
		ex.CI("load_balancer", lb, nil)
		ex.CI("listening_service", statsProxy+" (frontend, http)", nil)
		ex.Rel("contains", "load_balancer", lb, "listening_service", statsProxy+" (frontend, http)")
		for _, s := range u.sections {
			pool := s.pool.Name + " (backend, " + protoTCP + ")"
			front := s.pool.Name + " (frontend, " + protoTCP + ")"
			ex.CI("listening_service", pool, nil)
			ex.CI("listening_service", front, nil)
			ex.Rel("contains", "load_balancer", lb, "listening_service", pool)
			ex.Rel("contains", "load_balancer", lb, "listening_service", front)
			ex.Rel("depends_on", "listening_service", front, "listening_service", pool)
			if !u.legends {
				continue
			}
			for _, m := range s.pool.Members {
				name := m.Host + " (" + lbestate.Endpoint(m.Address, m.Port) + ")"
				ex.Member(m, name)
				ex.Rel("depends_on", "listening_service", pool, "listening_service", name)
			}
		}
		runs = append(runs, run)
	}
	return runs
}
