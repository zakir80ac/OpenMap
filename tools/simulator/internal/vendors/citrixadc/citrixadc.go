// REQ-QA-005 REQ-DISC-018 — simulated Citrix ADC / NetScaler (NITRO REST, /nitro/v1/config): X-NITRO-USER /
// X-NITRO-PASS header auth (and the POST login session with its NITRO_AUTH_TOKEN cookie), nshostname,
// nsversion, nshardware, nsip, hanode, lbvserver, lbvserver_service_binding, lbvserver_servicegroup_binding,
// servicegroup_servicegroupmember_binding, csvserver, csvserver_lbvserver_binding and
// csvserver_cspolicy_binding, with NITRO's errorcode envelope (354 on a bad credential, 258 for a missing
// resource, an envelope without the array for an object with no bindings).
//
// The synthetic estate holds no NetScaler, so this simulator GENERATES a deterministic HA pair (named
// <site>-adc-01/02) at the first site with VM-hosted API tiers. Its management IPs come from that site's
// estate management subnet and its VIPs from the site's VM subnets (lbestate.Allocator, skipping every
// estate address); its serials are hashed from the hostnames. Each API-tier component of the site becomes
// an SSL lbvserver whose backends are the estate VMs of that component on their estate listening services
// and addresses: even components through a service group, odd ones through directly bound services, so
// both binding paths run. One content-switching vserver targets every lbvserver (a default lbvserver
// binding plus one cs policy per lbvserver). Expectations come from this same generated set.
package citrixadc

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

	"github.com/openmap/openmap/tools/simulator/internal/estate"
	"github.com/openmap/openmap/tools/simulator/internal/sim"
	"github.com/openmap/openmap/tools/simulator/internal/vendors/lbestate"
)

const (
	nitro         = "/nitro/v1/config/"
	headerUser    = "X-NITRO-USER"
	headerPass    = "X-NITRO-PASS"
	authCookie    = "NITRO_AUTH_TOKEN"
	errBadCred    = 354
	errNoResource = 258
	tierAPI       = "api"
	vmPurpose     = "virtual machines"
	mgmtPurpose   = "network management"
	pairSize      = 2
	serialLen     = 10
	csPort        = 443
	serviceSSL    = "SSL"
	stateUp       = "UP"
	stateDown     = "DOWN"
	percent       = 100
	// version and hardware are the generated appliance's NITRO facts (a NetScaler 14.1 MPX).
	nsVersion  = "NetScaler NS14.1: Build 34.42.nc, Date: Sep 18 2025, 09:23:11   (64-bit)"
	nsMode     = "1"
	hwDesc     = "NetScaler MPX 15000-50G"
	hwSysID    = "450070"
	csName     = "cs_api_gateway"
	nameSuffix = "-adc-0"
)

type Vendor struct{}

func (Vendor) ID() string             { return "citrix-adc" }
func (Vendor) Collector() string      { return "citrix_adc" }
func (Vendor) Requirements() []string { return []string{"REQ-DISC-018"} }

func fronted(_, comp *estate.CI) bool { return comp.Str("tier") == tierAPI }

type vserver struct {
	pool    lbestate.Pool
	name    string
	address string
	// group is the service group name, empty when the members are bound as services.
	group string
}

func (v vserver) memberName(m lbestate.Member) string {
	if v.group != "" {
		return m.Host
	}
	return "svc_" + m.Host + "_" + strconv.Itoa(m.Port)
}

type appliance struct {
	hostname string
	serial   string
	nsip     string
	snip     string
	id       int
	peers    []*appliance
	vservers []vserver
	csVIP    string
}

func serialOf(hostname string) string {
	sum := sha256.Sum256([]byte("netscaler/" + hostname))
	return strings.ToUpper(hex.EncodeToString(sum[:]))[:serialLen]
}

// plan generates the HA pair; nil when the estate has no VM-hosted API tier.
func plan(e *estate.Estate) []*appliance {
	sites := lbestate.Sites(e, fronted)
	if len(sites) == 0 {
		return nil
	}
	site := sites[0]
	vips := lbestate.NewAllocator(e, site, vmPurpose)
	mgmt := lbestate.NewAllocator(e, site, mgmtPurpose)
	var vs []vserver
	for i, p := range lbestate.Pools(e, site, fronted) {
		v := vserver{pool: p, name: "lb_" + p.Name, address: vips.Next()}
		if i%2 == 0 {
			v.group = "sg_" + p.Name
		}
		vs = append(vs, v)
	}
	if len(vs) == 0 {
		return nil
	}
	csVIP := vips.Next()
	prefix := strings.ToLower(strings.SplitN(site, "-", pairSize)[0])
	var pair []*appliance
	for i := 0; i < pairSize; i++ {
		h := prefix + nameSuffix + strconv.Itoa(i+1)
		pair = append(pair, &appliance{hostname: h, serial: serialOf(h), nsip: mgmt.Next(), snip: mgmt.Next(), id: i, vservers: vs, csVIP: csVIP})
	}
	for _, a := range pair {
		for _, b := range pair {
			if a != b {
				a.peers = append(a.peers, b)
			}
		}
	}
	return pair
}

func envelope(extra map[string]any) map[string]any {
	doc := map[string]any{"errorcode": 0, "message": "Done", "severity": "NONE"}
	for k, v := range extra {
		doc[k] = v
	}
	return doc
}

func state(up bool) string {
	if up {
		return stateUp
	}
	return stateDown
}

func (v vserver) upMembers() int {
	n := 0
	for _, m := range v.pool.Members {
		if m.Up() {
			n++
		}
	}
	return n
}

// object renders one NITRO config object (nil when it does not exist).
func (a *appliance) object(kind, name string) map[string]any {
	byName := map[string]vserver{}
	byGroup := map[string]vserver{}
	for _, v := range a.vservers {
		byName[v.name] = v
		if v.group != "" {
			byGroup[v.group] = v
		}
	}
	switch kind {
	case "nshostname":
		return envelope(map[string]any{"nshostname": []any{map[string]any{"hostname": a.hostname, "ownernode": "255"}}})
	case "nsversion":
		return envelope(map[string]any{"nsversion": map[string]any{"version": nsVersion, "mode": nsMode}})
	case "nshardware":
		return envelope(map[string]any{"nshardware": map[string]any{"hwdescription": hwDesc, "sysid": hwSysID, "serialno": a.serial, "host": hex.EncodeToString([]byte(a.serial))[:serialLen], "encodedserialno": a.serial}})
	case "nsip":
		ips := []any{map[string]any{"ipaddress": a.nsip, "type": "NSIP", "netmask": "255.255.255.0", "state": "ENABLED"}, map[string]any{"ipaddress": a.snip, "type": "SNIP", "netmask": "255.255.255.0", "state": "ENABLED"}}
		for _, v := range a.vservers {
			ips = append(ips, map[string]any{"ipaddress": v.address, "type": "VIP", "netmask": "255.255.255.255", "state": "ENABLED"})
		}
		return envelope(map[string]any{"nsip": ips})
	case "hanode":
		roles := []string{"Primary", "Secondary"}
		nodes := []any{map[string]any{"id": "0", "ipaddress": a.nsip, "state": roles[a.id], "hastatus": stateUp}}
		for i, p := range a.peers {
			nodes = append(nodes, map[string]any{"id": strconv.Itoa(i + 1), "ipaddress": p.nsip, "state": roles[p.id], "hastatus": stateUp})
		}
		return envelope(map[string]any{"hanode": nodes})
	case "lbvserver":
		list := []any{}
		for _, v := range a.vservers {
			up := v.upMembers()
			list = append(list, map[string]any{"name": v.name, "ipv46": v.address, "port": v.pool.Port, "servicetype": serviceSSL, "curstate": state(up > 0), "effectivestate": state(up > 0),
				"lbmethod": "LEASTCONNECTION", "persistencetype": "NONE", "health": strconv.Itoa(up * percent / len(v.pool.Members)), "comment": v.pool.App.Str("title")})
		}
		return envelope(map[string]any{"lbvserver": list})
	case "lbvserver_service_binding":
		v, ok := byName[name]
		if !ok {
			return nil
		}
		if v.group != "" {
			return envelope(nil)
		}
		list := []any{}
		for _, m := range v.pool.Members {
			list = append(list, map[string]any{"name": v.name, "servicename": v.memberName(m), "ipv46": m.Address, "port": m.Port, "curstate": state(m.Up()), "weight": "1", "servicetype": serviceSSL})
		}
		return envelope(map[string]any{"lbvserver_service_binding": list})
	case "lbvserver_servicegroup_binding":
		v, ok := byName[name]
		if !ok {
			return nil
		}
		if v.group == "" {
			return envelope(nil)
		}
		return envelope(map[string]any{"lbvserver_servicegroup_binding": []any{map[string]any{"name": v.name, "servicegroupname": v.group}}})
	case "servicegroup_servicegroupmember_binding":
		v, ok := byGroup[name]
		if !ok {
			return nil
		}
		list := []any{}
		for _, m := range v.pool.Members {
			list = append(list, map[string]any{"servicegroupname": v.group, "ip": m.Address, "port": m.Port, "svrstate": state(m.Up()), "weight": "1", "servername": v.memberName(m)})
		}
		return envelope(map[string]any{"servicegroup_servicegroupmember_binding": list})
	case "csvserver":
		return envelope(map[string]any{"csvserver": []any{map[string]any{"name": csName, "ipv46": a.csVIP, "port": csPort, "servicetype": serviceSSL, "curstate": stateUp}}})
	case "csvserver_lbvserver_binding":
		if name != csName {
			return nil
		}
		return envelope(map[string]any{"csvserver_lbvserver_binding": []any{map[string]any{"name": csName, "lbvserver": a.vservers[0].name}}})
	case "csvserver_cspolicy_binding":
		if name != csName {
			return nil
		}
		list := []any{}
		for _, v := range a.vservers {
			list = append(list, map[string]any{"name": csName, "policyname": "pol_" + v.pool.Name, "targetlbvserver": v.name, "priority": strconv.Itoa(len(list) + 1)})
		}
		return envelope(map[string]any{"csvserver_cspolicy_binding": list})
	}
	return nil
}

func decode(r *http.Request, v any) error { return json.NewDecoder(r.Body).Decode(v) }

func nitroError(w http.ResponseWriter, status, code int, msg string) {
	sim.WriteJSON(w, status, map[string]any{"errorcode": code, "message": msg, "severity": "ERROR", "provenance": sim.Provenance})
}

func (a *appliance) handler(env *sim.Env) http.Handler {
	session := env.Token("nitro-" + a.serial)
	authed := func(r *http.Request) bool {
		if r.Header.Get(headerUser) == env.User && r.Header.Get(headerPass) == env.Secret {
			return true
		}
		c, err := r.Cookie(authCookie)
		return err == nil && c.Value == session
	}
	mux := http.NewServeMux()
	mux.HandleFunc("POST "+nitro+"login", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Login struct {
				Username string `json:"username"`
				Password string `json:"password"`
			} `json:"login"`
		}
		if err := decode(r, &body); err != nil || body.Login.Username != env.User || body.Login.Password != env.Secret {
			nitroError(w, http.StatusUnauthorized, errBadCred, "Invalid username or password")
			return
		}
		http.SetCookie(w, &http.Cookie{Name: authCookie, Value: session, Path: "/nitro/v1", HttpOnly: true, Secure: true})
		sim.WriteJSON(w, http.StatusCreated, map[string]any{"errorcode": 0, "message": "Done", "severity": "NONE", "sessionid": session})
	})
	mux.HandleFunc("GET "+nitro+"{rest...}", func(w http.ResponseWriter, r *http.Request) {
		if !authed(r) {
			nitroError(w, http.StatusUnauthorized, errBadCred, "Invalid username or password")
			return
		}
		kind, name, _ := strings.Cut(r.PathValue("rest"), "/")
		doc := a.object(kind, name)
		if doc == nil {
			nitroError(w, http.StatusNotFound, errNoResource, "No such resource ["+kind+"]")
			return
		}
		sim.WriteJSON(w, http.StatusOK, doc)
	})
	return mux
}

func (Vendor) Start(_ context.Context, e *estate.Estate, env *sim.Env) (*sim.Endpoint, error) {
	byName := map[string]*appliance{}
	keys := []string{}
	for _, a := range plan(e) {
		byName[a.hostname] = a
		keys = append(keys, a.hostname)
	}
	return sim.ServeEach(env, keys, true, func(k string) http.Handler { return byName[k].handler(env) })
}

func (Vendor) Runs(e *estate.Estate, ep *sim.Endpoint, env *sim.Env) []sim.Run {
	var runs []sim.Run
	for _, a := range plan(e) {
		run := sim.Run{
			Name:           a.hostname,
			Targets:        []sim.Target{{Kind: "host", Value: ep.Devices[a.hostname], Label: a.hostname}},
			Options:        map[string]any{"verifyTls": true, "caCertPem": env.CA.PEM},
			CredentialType: "password",
			Credential:     &sim.Credential{Type: "password", Fields: map[string]string{"username": env.User, "password": env.Secret}},
		}
		ex := lbestate.NewExpect(&run.Expect)
		ex.CI("load_balancer", a.hostname, map[string]string{"serialNumber": a.serial, "managementIp": a.nsip})
		vsNames := map[string]string{}
		for _, v := range a.vservers {
			vsName := v.name + " (" + lbestate.Endpoint(v.address, v.pool.Port) + ")"
			vsNames[v.name] = vsName
			ex.CI("listening_service", vsName, nil)
			ex.CI("ip_address", v.address, nil)
			ex.Rel("contains", "load_balancer", a.hostname, "listening_service", vsName)
			ex.Rel("uses_ip", "listening_service", vsName, "ip_address", v.address)
			for _, m := range v.pool.Members {
				mName := lbestate.Endpoint(v.memberName(m), m.Port)
				ex.Member(m, mName)
				ex.Rel("depends_on", "listening_service", vsName, "listening_service", mName)
			}
		}
		csListener := csName + " (cs " + lbestate.Endpoint(a.csVIP, csPort) + ")"
		ex.CI("listening_service", csListener, nil)
		ex.CI("ip_address", a.csVIP, nil)
		ex.Rel("contains", "load_balancer", a.hostname, "listening_service", csListener)
		ex.Rel("uses_ip", "listening_service", csListener, "ip_address", a.csVIP)
		for _, v := range a.vservers {
			ex.Rel("depends_on", "listening_service", csListener, "listening_service", vsNames[v.name])
		}
		runs = append(runs, run)
	}
	return runs
}
