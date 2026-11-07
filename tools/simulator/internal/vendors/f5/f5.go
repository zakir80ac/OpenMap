// REQ-QA-005 REQ-DISC-018 — simulated F5 BIG-IP (iControl REST): every estate load_balancer made by F5 gets
// its own HTTPS listener serving /mgmt/shared/authn/login (token sign-on), Basic or X-F5-Auth-Token auth,
// /mgmt/tm/cm/device (both members of the HA pair, selfDevice marking this one), /mgmt/tm/ltm/virtual and
// /mgmt/tm/ltm/pool (subcollections inlined only with expandSubcollections=true, as TMOS does) and
// /mgmt/tm/ltm/node. The estate holds the appliances (serial, management IP, model, TMOS version, HA role)
// but no LTM configuration, so the virtual servers are generated deterministically from the estate's
// applications (lbestate): each pair fronts the web tier and the UDP infrastructure services of its own
// site, its pool members are the estate VMs and hosts of that component with their listening services and
// estate addresses, and the VIPs come from the site's VM subnets. Both pair members carry the same
// configuration (config sync); the DR pair at a site without applications serves its device facts only.
package f5

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
	manufacturer   = "F5"
	partition      = "Common"
	tokenHeader    = "X-F5-Auth-Token"
	loginProvider  = "tmos"
	tokenTimeout   = 1200
	vmPurpose      = "virtual machines"
	tierWeb        = "web"
	tierInfra      = "infra"
	protoUDP       = "udp"
	stateUp        = "up"
	stateDown      = "down"
	modelPrefix    = "BIG-IP "
	haActive       = "active"
	macBytes       = 6
	selfTrue       = "true"
	selfFalse      = "false"
	expandParam    = "expandSubcollections"
	collectionKind = "tm:ltm:virtual:virtualcollectionstate"
)

// f5OUI is F5 Networks' IEEE organisationally unique identifier, the prefix of BIG-IP base MACs.
var f5OUI = []string{"00", "94", "a1"}

// platformIDs maps BIG-IP marketing names to TMOS platform ids (F5 K9476 platform table).
var platformIDs = map[string]string{"BIG-IP i7800": "C118", "BIG-IP i5800": "C119", "BIG-IP i10800": "C116"}

type Vendor struct{}

func (Vendor) ID() string             { return "f5-bigip" }
func (Vendor) Collector() string      { return "load_balancer" }
func (Vendor) Requirements() []string { return []string{"REQ-DISC-018"} }

func devices(e *estate.Estate) []*estate.CI {
	return e.OfType("load_balancer", func(c *estate.CI) bool { return c.Str("manufacturer") == manufacturer })
}

// fronted selects what a BIG-IP pair load-balances: the web tier and UDP infrastructure services (DNS).
func fronted(_, comp *estate.CI) bool {
	return comp.Str("tier") == tierWeb || (comp.Str("tier") == tierInfra && comp.Str("protocol") == protoUDP)
}

type vip struct {
	pool    lbestate.Pool
	address string
	// fqdnNodes marks pools whose members are FQDN nodes (the rest are static address nodes).
	fqdnNodes bool
}

func (v vip) proto() string {
	if v.pool.Protocol == protoUDP {
		return protoUDP
	}
	return "tcp"
}

func (v vip) virtualName() string { return "vs_" + v.pool.Name + "_" + strconv.Itoa(v.pool.Port) }
func (v vip) poolName() string    { return "pool_" + v.pool.Name }
func (v vip) path(name string) string {
	return "/" + partition + "/" + name
}

func (v vip) nodeName(m lbestate.Member) string {
	if v.fqdnNodes && m.FQDN != "" {
		return m.FQDN
	}
	return m.Host
}

func memberState(m lbestate.Member) string {
	if m.Up() {
		return stateUp
	}
	return stateDown
}

// plan is the LTM configuration of one site (shared by both members of its pair).
type plan struct {
	site string
	vips []vip
}

func sitePlans(e *estate.Estate) map[string]*plan {
	plans := map[string]*plan{}
	for _, d := range devices(e) {
		site := lbestate.SiteOf(e, d.ID("managementIp"))
		if _, ok := plans[site]; ok {
			continue
		}
		p := &plan{site: site}
		alloc := lbestate.NewAllocator(e, site, vmPurpose)
		for i, pool := range lbestate.Pools(e, site, fronted) {
			p.vips = append(p.vips, vip{pool: pool, address: alloc.Next(), fqdnNodes: i%2 == 0})
		}
		plans[site] = p
	}
	return plans
}

func hostname(e *estate.Estate, d *estate.CI) string {
	if dom := lbestate.Domain(e); dom != "" {
		return strings.ToLower(d.Name) + "." + dom
	}
	return strings.ToLower(d.Name)
}

// baseMac derives a stable MAC under F5's 00:94:a1 OUI from the serial (the estate holds no MAC).
func baseMac(serial string) string {
	sum := sha256.Sum256([]byte(serial))
	h := hex.EncodeToString(sum[:macBytes-len(f5OUI)])
	parts := append([]string{}, f5OUI...)
	for i := 0; i < len(h); i += 2 {
		parts = append(parts, h[i:i+2])
	}
	return strings.Join(parts, ":")
}

func deviceDoc(e *estate.Estate, d *estate.CI, self bool) map[string]any {
	failover := strings.ToLower(d.Str("haRole"))
	if failover == "" {
		failover = haActive
	}
	selfDevice := selfFalse
	if self {
		selfDevice = selfTrue
	}
	model := d.Str("model")
	return map[string]any{
		"kind": "tm:cm:device:devicestate", "name": hostname(e, d), "partition": partition, "fullPath": "/" + partition + "/" + hostname(e, d),
		"hostname": hostname(e, d), "managementIp": d.ID("managementIp"), "marketingName": model, "platformId": platformIDs[model],
		"chassisId": d.ID("serialNumber"), "version": d.Str("osVersion"), "edition": "Final", "product": "BIG-IP",
		"failoverState": failover, "baseMac": baseMac(d.ID("serialNumber")), "selfDevice": selfDevice,
		"activeModules": []string{"LTM, " + strings.TrimPrefix(model, modelPrefix)},
	}
}

type device struct {
	ci   *estate.CI
	peer []*estate.CI
	plan *plan
}

func (dv *device) virtuals(expand bool) []any {
	out := []any{}
	for _, v := range dv.plan.vips {
		profiles := []string{"http", "clientssl"}
		if v.proto() == protoUDP {
			profiles = []string{"udp_gtm_dns"}
		}
		doc := map[string]any{
			"kind": "tm:ltm:virtual:virtualstate", "name": v.virtualName(), "partition": partition, "fullPath": v.path(v.virtualName()),
			"destination": v.path(lbestate.Endpoint(v.address, v.pool.Port)), "ipProtocol": v.proto(), "pool": v.path(v.poolName()),
			"enabled": true, "description": v.pool.App.Str("title"), "rules": []string{},
		}
		ref := map[string]any{"link": "https://localhost/mgmt/tm/ltm/virtual/~" + partition + "~" + v.virtualName() + "/profiles", "isSubcollection": true}
		if expand {
			items := []any{}
			for _, p := range profiles {
				items = append(items, map[string]string{"name": p, "partition": partition, "fullPath": "/" + partition + "/" + p})
			}
			ref["items"] = items
		}
		doc["profilesReference"] = ref
		out = append(out, doc)
	}
	return out
}

func (dv *device) pools(expand bool) []any {
	out := []any{}
	for _, v := range dv.plan.vips {
		monitor, mode := "/"+partition+"/https", "least-connections-member"
		if v.proto() == protoUDP {
			monitor, mode = "/"+partition+"/dns", "round-robin"
		}
		ref := map[string]any{"link": "https://localhost/mgmt/tm/ltm/pool/~" + partition + "~" + v.poolName() + "/members", "isSubcollection": true}
		if expand {
			items := []any{}
			for _, m := range v.pool.Members {
				name := lbestate.Endpoint(v.nodeName(m), m.Port)
				items = append(items, map[string]any{"kind": "tm:ltm:pool:members:membersstate", "name": name, "partition": partition, "fullPath": "/" + partition + "/" + name,
					"address": m.Address, "state": memberState(m), "session": "monitor-enabled", "ratio": 1, "priorityGroup": 0})
			}
			ref["items"] = items
		}
		out = append(out, map[string]any{"kind": "tm:ltm:pool:poolstate", "name": v.poolName(), "partition": partition, "fullPath": v.path(v.poolName()),
			"loadBalancingMode": mode, "monitor": monitor, "membersReference": ref})
	}
	return out
}

func (dv *device) nodes() []any {
	out := []any{}
	seen := map[string]bool{}
	for _, v := range dv.plan.vips {
		for _, m := range v.pool.Members {
			name := v.nodeName(m)
			if seen[name] {
				continue
			}
			seen[name] = true
			doc := map[string]any{"kind": "tm:ltm:node:nodestate", "name": name, "partition": partition, "fullPath": "/" + partition + "/" + name, "address": m.Address, "state": memberState(m)}
			if v.fqdnNodes && m.FQDN != "" {
				doc["fqdn"] = map[string]any{"addressFamily": "ipv4", "autopopulate": "disabled", "tmName": m.FQDN}
			} else {
				doc["fqdn"] = map[string]any{"addressFamily": "ipv4", "autopopulate": "disabled"}
			}
			out = append(out, doc)
		}
	}
	return out
}

func collection(kind string, items []any) map[string]any {
	return map[string]any{"kind": kind, "selfLink": "https://localhost/mgmt/tm", "items": items}
}

func (dv *device) handler(e *estate.Estate, env *sim.Env) http.Handler {
	token := env.Token("f5-" + dv.ci.ID("serialNumber"))
	authed := func(next func(w http.ResponseWriter, r *http.Request)) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			if !env.BasicOK(r) && r.Header.Get(tokenHeader) != token {
				sim.WriteJSON(w, http.StatusUnauthorized, map[string]any{"code": http.StatusUnauthorized, "message": "Authorization failed: user=" + env.User + " resource=" + r.URL.Path, "errorStack": []string{}, "provenance": sim.Provenance})
				return
			}
			next(w, r)
		}
	}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /mgmt/shared/authn/login", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Username          string `json:"username"`
			Password          string `json:"password"`
			LoginProviderName string `json:"loginProviderName"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Username != env.User || body.Password != env.Secret {
			sim.WriteJSON(w, http.StatusUnauthorized, map[string]any{"code": http.StatusUnauthorized, "message": "Authentication failed.", "errorStack": []string{}, "provenance": sim.Provenance})
			return
		}
		sim.WriteJSON(w, http.StatusOK, map[string]any{"username": body.Username, "loginProviderName": loginProvider,
			"token": map[string]any{"token": token, "name": token, "userName": body.Username, "timeout": tokenTimeout, "authProviderName": loginProvider}})
	})
	mux.HandleFunc("GET /mgmt/tm/cm/device", authed(func(w http.ResponseWriter, _ *http.Request) {
		items := []any{deviceDoc(e, dv.ci, true)}
		for _, p := range dv.peer {
			items = append(items, deviceDoc(e, p, false))
		}
		sim.WriteJSON(w, http.StatusOK, collection("tm:cm:device:devicecollectionstate", items))
	}))
	mux.HandleFunc("GET /mgmt/tm/ltm/virtual", authed(func(w http.ResponseWriter, r *http.Request) {
		sim.WriteJSON(w, http.StatusOK, collection(collectionKind, dv.virtuals(r.URL.Query().Get(expandParam) == "true")))
	}))
	mux.HandleFunc("GET /mgmt/tm/ltm/pool", authed(func(w http.ResponseWriter, r *http.Request) {
		sim.WriteJSON(w, http.StatusOK, collection("tm:ltm:pool:poolcollectionstate", dv.pools(r.URL.Query().Get(expandParam) == "true")))
	}))
	mux.HandleFunc("GET /mgmt/tm/ltm/node", authed(func(w http.ResponseWriter, _ *http.Request) {
		sim.WriteJSON(w, http.StatusOK, collection("tm:ltm:node:nodecollectionstate", dv.nodes()))
	}))
	return mux
}

func load(e *estate.Estate) []*device {
	plans := sitePlans(e)
	all := devices(e)
	var out []*device
	for _, d := range all {
		site := lbestate.SiteOf(e, d.ID("managementIp"))
		dv := &device{ci: d, plan: plans[site]}
		for _, o := range all {
			if o != d && lbestate.SiteOf(e, o.ID("managementIp")) == site {
				dv.peer = append(dv.peer, o)
			}
		}
		out = append(out, dv)
	}
	return out
}

func (Vendor) Start(_ context.Context, e *estate.Estate, env *sim.Env) (*sim.Endpoint, error) {
	byName := map[string]*device{}
	keys := []string{}
	for _, dv := range load(e) {
		byName[dv.ci.Name] = dv
		keys = append(keys, dv.ci.Name)
	}
	return sim.ServeEach(env, keys, true, func(k string) http.Handler { return byName[k].handler(e, env) })
}

func (Vendor) Runs(e *estate.Estate, ep *sim.Endpoint, env *sim.Env) []sim.Run {
	var runs []sim.Run
	for _, dv := range load(e) {
		d := dv.ci
		// Active units sign on for an iControl token; standby units use Basic auth, so both paths run.
		token := strings.ToLower(d.Str("haRole")) == haActive
		run := sim.Run{
			Name:           d.Name,
			Targets:        []sim.Target{{Kind: "host", Value: ep.Devices[d.Name], Label: d.Name}},
			Options:        map[string]any{"verifyTls": true, "caCertPem": env.CA.PEM, "tokenAuth": token},
			CredentialType: "password",
			Credential:     &sim.Credential{Type: "password", Fields: map[string]string{"username": env.User, "password": env.Secret}},
		}
		ex := lbestate.NewExpect(&run.Expect)
		lbName := hostname(e, d)
		// The BIG-IP hostname is the FQDN; the estate names the appliance by its SNMP sysName. The CI is
		// matched on the collector's name and carries the estate identity for the drift check.
		ex.CI("load_balancer", lbName, d.Identity)
		for _, v := range dv.plan.vips {
			vsName := v.virtualName() + " (" + lbestate.Endpoint(v.address, v.pool.Port) + ")"
			ex.CI("listening_service", vsName, nil)
			ex.CI("ip_address", v.address, nil)
			ex.Rel("contains", "load_balancer", lbName, "listening_service", vsName)
			ex.Rel("uses_ip", "listening_service", vsName, "ip_address", v.address)
			for _, m := range v.pool.Members {
				mName := lbestate.Endpoint(v.nodeName(m), m.Port)
				ex.Member(m, mName)
				ex.Rel("depends_on", "listening_service", vsName, "listening_service", mName)
				if v.fqdnNodes && m.FQDN != "" {
					ex.RelToRef("runs_on", "listening_service", mName, "host", map[string]string{"fqdn": m.FQDN})
				}
			}
		}
		runs = append(runs, run)
	}
	return runs
}
