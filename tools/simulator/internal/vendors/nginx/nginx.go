// REQ-QA-005 REQ-DISC-018 — simulated NGINX, both editions the collector reads.
//
// Open source (estate): every estate VM whose listening service is run by the nginx process (the web tiers
// of the bank applications; the estate's NGINX software is unlicensed, so open source) gets its own
// listener serving `location /stub_status { stub_status; }` and answering the Plus API probe /api/ with
// NGINX's 404 page, the exchange recorded from a real open-source container (packages/testing/fixtures/
// vendor/load_balancer/nginx-nginx-1.29.5). The Server header carries the VM's estate NGINX version. Even
// VMs serve HTTPS under the simulated CA (the collector pins it with caCertPem), odd ones clear text.
// Counters are hashed from the VM name.
//
// NGINX Plus (GENERATED: the estate holds no Plus licence): one API gateway (<site>-nginx-gw-01) at the
// first site with VM-hosted API tiers serves the Plus REST API (/api/ version list, /api/<v>/nginx,
// /api/<v>/http/upstreams, /api/<v>/http/server_zones) over HTTPS with Basic auth. Each API-tier component
// is one upstream and one server zone of the same name; its peers are the component's estate VMs (`server`
// is the estate address, `name` the configured FQDN), healthy when the estate VM is powered on.
// Expectations come from the estate VMs and this generated gateway.
package nginx

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"net/http"
	"strconv"
	"strings"

	"github.com/openmap/openmap/tools/simulator/internal/estate"
	"github.com/openmap/openmap/tools/simulator/internal/sim"
	"github.com/openmap/openmap/tools/simulator/internal/vendors/lbestate"
)

const (
	process       = "nginx"
	softwareName  = "NGINX"
	relRunsOn     = "runs_on"
	relInstalled  = "installed_on"
	typeListener  = "listening_service"
	typeSoftware  = "software_instance"
	stubPath      = "/stub_status"
	apiPath       = "/api/"
	tierAPI       = "api"
	gatewaySuffix = "-nginx-gw-01"
	// The generated gateway's NGINX Plus release and API version.
	plusVersion = "1.27.4"
	plusBuild   = "nginx-plus-r34"
	plusAPI     = 9
	plusAddress = "0.0.0.0"
	plusPID     = 1021
	plusPPID    = 1
	loadedAt    = "2026-10-01T00:00:00.000Z"
	counterSpan = 100000
	reqsPerConn = 3
	stateUp     = "up"
	stateDown   = "unhealthy"
)

type Vendor struct{}

func (Vendor) ID() string             { return "nginx" }
func (Vendor) Collector() string      { return "nginx" }
func (Vendor) Requirements() []string { return []string{"REQ-DISC-018"} }

func counter(parts ...string) int64 {
	sum := sha256.Sum256([]byte(strings.Join(parts, "/")))
	return int64(binary.BigEndian.Uint64(sum[:8])%counterSpan) + 1
}

// instance is one open-source NGINX on an estate VM.
type instance struct {
	vm      *estate.CI
	version string
	secure  bool
}

func instances(e *estate.Estate) []instance {
	var out []instance
	seen := map[*estate.CI]bool{}
	for _, ls := range e.OfType(typeListener, func(c *estate.CI) bool { return c.Str("process") == process }) {
		for _, vm := range e.From(ls, relRunsOn) {
			if seen[vm] {
				continue
			}
			seen[vm] = true
			version := ""
			for _, si := range e.To(vm, relInstalled) {
				if si.Type == typeSoftware && si.Str("name") == softwareName {
					version = si.Str("version")
				}
			}
			out = append(out, instance{vm: vm, version: version, secure: len(out)%2 == 0})
		}
	}
	return out
}

func (in instance) server() string {
	if in.version == "" {
		return process
	}
	return process + "/" + in.version
}

func (in instance) handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Server", in.server())
		switch r.URL.Path {
		case stubPath:
			accepts := counter(in.vm.Name, "accepts")
			active := accepts%reqsPerConn + 1
			body := "Active connections: " + strconv.FormatInt(active, 10) + " \nserver accepts handled requests\n " +
				strconv.FormatInt(accepts, 10) + " " + strconv.FormatInt(accepts, 10) + " " + strconv.FormatInt(accepts*reqsPerConn, 10) + " \n" +
				"Reading: 0 Writing: 1 Waiting: " + strconv.FormatInt(active-1, 10) + " \n"
			sim.WriteRaw(w, http.StatusOK, "text/plain", []byte(body))
		default:
			sim.WriteRaw(w, http.StatusNotFound, "text/html", []byte("<html>\n<head><title>404 Not Found</title></head>\n<body>\n<center><h1>404 Not Found</h1></center>\n<hr><center>"+in.server()+"</center>\n</body>\n</html>\n"))
		}
	})
}

// gateway is the generated NGINX Plus API gateway.
type gateway struct {
	name  string
	pools []lbestate.Pool
}

func gatewayPlan(e *estate.Estate) *gateway {
	keep := func(_, comp *estate.CI) bool { return comp.Str("tier") == tierAPI }
	sites := lbestate.Sites(e, keep)
	if len(sites) == 0 {
		return nil
	}
	g := &gateway{name: strings.ToLower(strings.SplitN(sites[0], "-", 2)[0]) + gatewaySuffix, pools: lbestate.Pools(e, sites[0], keep)}
	if len(g.pools) == 0 {
		return nil
	}
	return g
}

func peerName(m lbestate.Member) string {
	if m.FQDN != "" {
		return lbestate.Endpoint(m.FQDN, m.Port)
	}
	return lbestate.Endpoint(m.Address, m.Port)
}

func (g *gateway) doc(path string) any {
	base := "/api/" + strconv.Itoa(plusAPI)
	switch path {
	case apiPath:
		versions := []int{}
		for v := 1; v <= plusAPI; v++ {
			versions = append(versions, v)
		}
		return versions
	case base + "/nginx":
		return map[string]any{"version": plusVersion, "build": plusBuild, "address": plusAddress, "generation": 1, "load_timestamp": loadedAt, "timestamp": loadedAt, "pid": plusPID, "ppid": plusPPID}
	case base + "/http/upstreams":
		out := map[string]any{}
		for _, p := range g.pools {
			peers := []any{}
			for i, m := range p.Members {
				state := stateUp
				if !m.Up() {
					state = stateDown
				}
				reqs := counter(g.name, p.Name, m.Host)
				peers = append(peers, map[string]any{"id": i, "server": lbestate.Endpoint(m.Address, m.Port), "name": peerName(m), "backup": false, "weight": 1, "state": state,
					"active": reqs % reqsPerConn, "requests": reqs, "downtime": 0, "health_checks": map[string]any{"checks": reqs / reqsPerConn, "fails": 0, "unhealthy": 0}})
			}
			out[p.Name] = map[string]any{"peers": peers, "keepalive": 0, "zombies": 0, "zone": p.Name}
		}
		return out
	case base + "/http/server_zones":
		out := map[string]any{}
		for _, p := range g.pools {
			reqs := counter(g.name, p.Name)
			out[p.Name] = map[string]any{"processing": 0, "requests": reqs, "discarded": 0, "received": reqs * counterSpan, "sent": reqs * counterSpan, "responses": map[string]any{"total": reqs}}
		}
		return out
	}
	return nil
}

func (g *gateway) handler(env *sim.Env) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Server", process+"/"+plusVersion)
		if !env.BasicOK(r) {
			w.Header().Set("WWW-Authenticate", `Basic realm="NGINX Plus API"`)
			sim.WriteRaw(w, http.StatusUnauthorized, "text/html", []byte("<html><body><h1>401 Authorization Required</h1></body></html>\n"))
			return
		}
		if r.URL.Path == stubPath {
			sim.WriteRaw(w, http.StatusOK, "text/plain", []byte("Active connections: 1 \nserver accepts handled requests\n 1 1 1 \nReading: 0 Writing: 1 Waiting: 0 \n"))
			return
		}
		doc := g.doc(r.URL.Path)
		if doc == nil {
			sim.WriteJSON(w, http.StatusNotFound, map[string]any{"error": map[string]any{"status": http.StatusNotFound, "text": "path not found", "code": "PathNotFound"}, "provenance": sim.Provenance})
			return
		}
		sim.WriteJSON(w, http.StatusOK, doc)
	})
}

func (Vendor) Start(_ context.Context, e *estate.Estate, env *sim.Env) (*sim.Endpoint, error) {
	group := &sim.Endpoint{Host: sim.AdvertiseHost(), State: map[string]any{}, Devices: map[string]string{}}
	add := func(ep *sim.Endpoint, err error) error {
		if err != nil {
			return err
		}
		for k, u := range ep.Devices {
			group.Devices[k] = u
		}
		if group.State["log"] == nil {
			group.State["log"] = ep.State["log"]
		}
		group.OnClose(ep.Close)
		return nil
	}
	byName := map[string]instance{}
	var secure, plain []string
	for _, in := range instances(e) {
		byName[in.vm.Name] = in
		if in.secure {
			secure = append(secure, in.vm.Name)
		} else {
			plain = append(plain, in.vm.Name)
		}
	}
	h := func(k string) http.Handler { return byName[k].handler() }
	if err := add(sim.ServeEach(env, secure, true, h)); err != nil {
		_ = group.Close()
		return nil, err
	}
	if err := add(sim.ServeEach(env, plain, false, h)); err != nil {
		_ = group.Close()
		return nil, err
	}
	if g := gatewayPlan(e); g != nil {
		if err := add(sim.ServeEach(env, []string{g.name}, true, func(string) http.Handler { return g.handler(env) })); err != nil {
			_ = group.Close()
			return nil, err
		}
	}
	return group, nil
}

func (Vendor) Runs(e *estate.Estate, ep *sim.Endpoint, env *sim.Env) []sim.Run {
	// Neither stub_status nor the Plus API names the instance: the collector keys the load balancer on the
	// target host, which is the simulator's advertised host.
	lb := sim.AdvertiseHost()
	var runs []sim.Run
	for _, in := range instances(e) {
		run := sim.Run{Name: in.vm.Name, Targets: []sim.Target{{Kind: "url", Value: ep.Devices[in.vm.Name], Label: in.vm.Name}}, Options: map[string]any{}, CredentialType: "none"}
		if in.secure {
			run.Options = map[string]any{"verifyTls": true, "caCertPem": env.CA.PEM}
		}
		lbestate.NewExpect(&run.Expect).CI("load_balancer", lb, nil)
		runs = append(runs, run)
	}
	g := gatewayPlan(e)
	if g == nil {
		return runs
	}
	run := sim.Run{
		Name:           g.name,
		Targets:        []sim.Target{{Kind: "url", Value: ep.Devices[g.name], Label: g.name}},
		Options:        map[string]any{"verifyTls": true, "caCertPem": env.CA.PEM},
		CredentialType: "password",
		Credential:     &sim.Credential{Type: "password", Fields: map[string]string{"username": env.User, "password": env.Secret}},
	}
	ex := lbestate.NewExpect(&run.Expect)
	ex.CI("load_balancer", lb, nil)
	for _, p := range g.pools {
		zone, upstream := p.Name+" (server zone)", p.Name+" (upstream)"
		ex.CI("listening_service", zone, nil)
		ex.CI("listening_service", upstream, nil)
		ex.Rel("contains", "load_balancer", lb, "listening_service", zone)
		ex.Rel("contains", "load_balancer", lb, "listening_service", upstream)
		ex.Rel("depends_on", "listening_service", zone, "listening_service", upstream)
		for _, m := range p.Members {
			ex.Member(m, peerName(m))
			ex.Rel("depends_on", "listening_service", upstream, "listening_service", peerName(m))
		}
	}
	return append(runs, run)
}
