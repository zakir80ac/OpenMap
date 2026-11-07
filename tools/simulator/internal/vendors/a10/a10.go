// REQ-QA-005 REQ-DISC-018 — simulated A10 Thunder (ACOS aXAPI v3): POST /axapi/v3/auth exchanges the
// credential for a session signature that every later call presents as `Authorization: A10 <signature>`
// (an unknown or logged-off signature answers 401), /version/oper, /interface/management, /slb/virtual-server,
// /slb/service-group, /slb/server, /slb/service-group/oper and POST /logoff, which ends the session.
//
// The synthetic estate holds no A10 appliance, so this simulator GENERATES one deterministic Thunder (named
// <site>-a10-01) at the last site with VM-hosted API tiers (the NetScaler pair takes the first). Its
// management IP comes from that site's estate management subnet, its VIPs from the site's VM subnets
// (lbestate.Allocator, skipping every estate address) and its serial is hashed from the hostname. Each
// API-tier component of the site becomes a virtual server with one HTTPS port bound to a service group whose
// members are the component's estate VMs on their estate listening services: even components name their
// real servers by address, odd ones by FQDN, so both member paths of the collector run. Member health
// follows the estate VM power state. Expectations come from this same generated set.
package a10

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"sync"

	"github.com/openmap/openmap/tools/simulator/internal/estate"
	"github.com/openmap/openmap/tools/simulator/internal/sim"
	"github.com/openmap/openmap/tools/simulator/internal/vendors/lbestate"
)

const (
	apiBase      = "/axapi/v3"
	authScheme   = "A10 "
	tierAPI      = "api"
	vmPurpose    = "virtual machines"
	mgmtPurpose  = "network management"
	serialHexLen = 10
	serialPrefix = "TH33"
	nameSuffix   = "-a10-01"
	protoHTTPS   = "https"
	protoTCP     = "tcp"
	// errBadCredential and errBadSession are the ACOS error codes for a rejected sign-on and an unknown
	// session signature.
	errBadCredential = 520486915
	errBadSession    = 1023410176
	// The generated appliance's facts (a Thunder 3350S on ACOS 6.0).
	platform  = "Thunder 3350S"
	swVersion = "6.0.5-P1 build 31 (Jun-18-2025,09:22)"
	upTime    = "212 days, 4 hours, 18 minutes"
	haActive  = "Active"
	mgmtMask  = "255.255.255.0"
)

type Vendor struct{}

func (Vendor) ID() string             { return "a10-thunder" }
func (Vendor) Collector() string      { return "a10_thunder" }
func (Vendor) Requirements() []string { return []string{"REQ-DISC-018"} }

func fronted(_, comp *estate.CI) bool { return comp.Str("tier") == tierAPI }

type service struct {
	pool    lbestate.Pool
	address string
	byFQDN  bool
}

func (s service) virtualName() string { return "vip-" + s.pool.Name }
func (s service) groupName() string   { return "sg-" + s.pool.Name }

// serverName is the slb server a member points at (its FQDN or its short host name).
func (s service) serverName(m lbestate.Member) string {
	if s.byFQDN && m.FQDN != "" {
		return m.FQDN
	}
	return m.Host
}

type thunder struct {
	hostname string
	serial   string
	mgmt     string
	services []service
}

func plan(e *estate.Estate) *thunder {
	sites := lbestate.Sites(e, fronted)
	if len(sites) == 0 {
		return nil
	}
	site := sites[len(sites)-1]
	vips := lbestate.NewAllocator(e, site, vmPurpose)
	mgmt := lbestate.NewAllocator(e, site, mgmtPurpose)
	hostname := strings.ToLower(strings.SplitN(site, "-", 2)[0]) + nameSuffix
	sum := sha256.Sum256([]byte("a10/" + hostname))
	t := &thunder{hostname: hostname, serial: serialPrefix + strings.ToUpper(hex.EncodeToString(sum[:]))[:serialHexLen], mgmt: mgmt.Next()}
	for i, p := range lbestate.Pools(e, site, fronted) {
		t.services = append(t.services, service{pool: p, address: vips.Next(), byFQDN: i%2 == 1})
	}
	if len(t.services) == 0 {
		return nil
	}
	return t
}

func memberOper(m lbestate.Member) string {
	if m.Up() {
		return "Up"
	}
	return "Down"
}

func (t *thunder) docs(path string) any {
	switch path {
	case "/version/oper":
		return map[string]any{"version": map[string]any{"oper": map[string]any{"hw-platform": platform, "sw-version": swVersion, "serial-number": t.serial, "hostname": t.hostname, "ha-state": haActive, "up-time": upTime}}}
	case "/interface/management":
		return map[string]any{"management": map[string]any{"ip": map[string]any{"ipv4-address": t.mgmt, "ipv4-netmask": mgmtMask, "dhcp": 0}, "action": "enable", "a10-url": apiBase + "/interface/management"}}
	case "/slb/virtual-server":
		list := []any{}
		for _, s := range t.services {
			port := map[string]any{"port-number": s.pool.Port, "protocol": protoHTTPS, "service-group": s.groupName(), "action": "enable", "name": "_" + s.address + "_HTTPS_" + strconv.Itoa(s.pool.Port)}
			list = append(list, map[string]any{"name": s.virtualName(), "ip-address": s.address, "enable-disable-action": "enable", "port-list": []any{port}, "a10-url": apiBase + "/slb/virtual-server/" + s.virtualName()})
		}
		return map[string]any{"virtual-server-list": list}
	case "/slb/service-group":
		list := []any{}
		for _, s := range t.services {
			members := []any{}
			for _, m := range s.pool.Members {
				members = append(members, map[string]any{"name": s.serverName(m), "port": m.Port, "member-state": "enable", "member-priority": 1})
			}
			list = append(list, map[string]any{"name": s.groupName(), "protocol": protoTCP, "lb-method": "least-connection", "health-check": "hm-https", "member-list": members})
		}
		return map[string]any{"service-group-list": list}
	case "/slb/server":
		list := []any{}
		seen := map[string]bool{}
		for _, s := range t.services {
			for _, m := range s.pool.Members {
				name := s.serverName(m)
				if seen[name] {
					continue
				}
				seen[name] = true
				doc := map[string]any{"name": name, "action": "enable", "port-list": []any{map[string]any{"port-number": m.Port, "protocol": protoTCP}}}
				if s.byFQDN && m.FQDN != "" {
					doc["fqdn-name"] = m.FQDN
				} else {
					doc["host"] = m.Address
				}
				list = append(list, doc)
			}
		}
		return map[string]any{"server-list": list}
	case "/slb/service-group/oper":
		list := []any{}
		for _, s := range t.services {
			members := []any{}
			up := 0
			for _, m := range s.pool.Members {
				if m.Up() {
					up++
				}
				members = append(members, map[string]any{"member-name": s.serverName(m), "port": m.Port, "oper": map[string]any{"state": memberOper(m)}})
			}
			state := "Functional Up"
			if up == 0 {
				state = "Functional Down"
			}
			list = append(list, map[string]any{"name": s.groupName(), "oper": map[string]any{"state": state}, "member-list": members})
		}
		return map[string]any{"service-group-list": list}
	}
	return nil
}

func failure(w http.ResponseWriter, code int, msg string) {
	sim.WriteJSON(w, http.StatusUnauthorized, map[string]any{"response": map[string]any{"status": "fail", "err": map[string]any{"code": code, "msg": msg}}, "provenance": sim.Provenance})
}

func (t *thunder) handler(env *sim.Env) http.Handler {
	var mu sync.Mutex
	sessions := map[string]bool{}
	issued := 0
	signed := func(r *http.Request) bool {
		mu.Lock()
		defer mu.Unlock()
		return strings.HasPrefix(r.Header.Get("Authorization"), authScheme) && sessions[strings.TrimPrefix(r.Header.Get("Authorization"), authScheme)]
	}
	mux := http.NewServeMux()
	mux.HandleFunc("POST "+apiBase+"/auth", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Credentials struct {
				Username string `json:"username"`
				Password string `json:"password"`
			} `json:"credentials"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Credentials.Username != env.User || body.Credentials.Password != env.Secret {
			failure(w, errBadCredential, "Invalid username or password")
			return
		}
		mu.Lock()
		issued++
		sum := sha256.Sum256([]byte(env.Token("a10-"+t.serial) + "/" + strconv.Itoa(issued)))
		sig := hex.EncodeToString(sum[:])
		sessions[sig] = true
		mu.Unlock()
		sim.WriteJSON(w, http.StatusOK, map[string]any{"authresponse": map[string]any{"signature": sig, "description": "the signature should be set in Authorization header for following request."}})
	})
	mux.HandleFunc("POST "+apiBase+"/logoff", func(w http.ResponseWriter, r *http.Request) {
		if !signed(r) {
			failure(w, errBadSession, "Invalid session ID")
			return
		}
		mu.Lock()
		delete(sessions, strings.TrimPrefix(r.Header.Get("Authorization"), authScheme))
		mu.Unlock()
		sim.WriteJSON(w, http.StatusOK, map[string]any{"response": map[string]any{"status": "OK"}})
	})
	mux.HandleFunc("GET "+apiBase+"/{rest...}", func(w http.ResponseWriter, r *http.Request) {
		if !signed(r) {
			failure(w, errBadSession, "Invalid session ID")
			return
		}
		doc := t.docs("/" + r.PathValue("rest"))
		if doc == nil {
			sim.NotFound(w)
			return
		}
		sim.WriteJSON(w, http.StatusOK, doc)
	})
	return mux
}

func (Vendor) Start(_ context.Context, e *estate.Estate, env *sim.Env) (*sim.Endpoint, error) {
	t := plan(e)
	keys := []string{}
	if t != nil {
		keys = append(keys, t.hostname)
	}
	return sim.ServeEach(env, keys, true, func(string) http.Handler { return t.handler(env) })
}

func (Vendor) Runs(e *estate.Estate, ep *sim.Endpoint, env *sim.Env) []sim.Run {
	t := plan(e)
	if t == nil {
		return nil
	}
	run := sim.Run{
		Name:           t.hostname,
		Targets:        []sim.Target{{Kind: "host", Value: ep.Devices[t.hostname], Label: t.hostname}},
		Options:        map[string]any{"verifyTls": true, "caCertPem": env.CA.PEM},
		CredentialType: "password",
		Credential:     &sim.Credential{Type: "password", Fields: map[string]string{"username": env.User, "password": env.Secret}},
	}
	ex := lbestate.NewExpect(&run.Expect)
	ex.CI("load_balancer", t.hostname, map[string]string{"serialNumber": t.serial, "managementIp": t.mgmt})
	for _, s := range t.services {
		poolName := s.groupName() + " (service group)"
		ex.CI("listening_service", poolName, nil)
		ex.Rel("contains", "load_balancer", t.hostname, "listening_service", poolName)
		for _, m := range s.pool.Members {
			mName := lbestate.Endpoint(s.serverName(m), m.Port)
			if s.byFQDN && m.FQDN != "" {
				var sid map[string]string
				if m.Service != nil {
					sid = m.Service.Identity
				}
				ex.CI("listening_service", mName, sid)
				ex.RelToRef("runs_on", "listening_service", mName, "host", map[string]string{"fqdn": m.FQDN})
			} else {
				ex.Member(m, mName)
			}
			ex.Rel("depends_on", "listening_service", poolName, "listening_service", mName)
		}
		vsName := s.virtualName() + " (" + lbestate.Endpoint(s.address, s.pool.Port) + ")"
		ex.CI("listening_service", vsName, nil)
		ex.CI("ip_address", s.address, nil)
		ex.Rel("contains", "load_balancer", t.hostname, "listening_service", vsName)
		ex.Rel("uses_ip", "listening_service", vsName, "ip_address", s.address)
		ex.Rel("depends_on", "listening_service", vsName, "listening_service", poolName)
	}
	return []sim.Run{run}
}
