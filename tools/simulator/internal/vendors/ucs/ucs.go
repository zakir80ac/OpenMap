// REQ-QA-005 REQ-DISC-013 — simulated Cisco UCS Manager XML API: POST /nuova with aaaLogin (inName/inPassword
// answered with a per-login outCookie), configResolveClass for topSystem, networkElement, equipmentChassis,
// computeBlade, computeRackUnit and mgmtIf (the cookie is required; error 552 otherwise), and aaaLogout, which
// invalidates the cookie. Attributes follow the UCSM object model (mgmtIf carries the CIMC address in extIp,
// subject is blade / rack / sw). The estate has no Cisco compute, so one UCS domain is seeded deterministically
// from its name: two fabric interconnects, two 5108 chassis with four B200 M6 blades each and two C240 M6 rack
// units under the domain, one of them without a service profile; the expectations come from that seeded set.
package ucs

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/xml"
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"

	"github.com/openmap/openmap/tools/simulator/internal/estate"
	"github.com/openmap/openmap/tools/simulator/internal/sim"
)

const (
	domainName       = "UCS-RYD-01"
	chassisCount     = 2
	bladesPerChassis = 4
	rackUnits        = 2
	cpusPerServer    = 2
	coresPerServer   = 64
	memoryMb         = 524288
	ucsmVersion      = "4.2(3e)"
	refreshPeriod    = "600"
	maxBody          = 1 << 20
	// cookieEpoch is the fixed login instant UCSM puts in front of its cookies, so runs are reproducible.
	cookieEpoch = "1735689600"
	errAuth     = "551"
	errAuthz    = "552"
	errClass    = "103"
	fiPrefix    = "10.250.0."
	cimcPrefix  = "10.250.9."
	fiHostBase  = 11
	cimcHostMin = 11
)

type Vendor struct{}

func (Vendor) ID() string             { return "cisco-ucsm" }
func (Vendor) Collector() string      { return "cisco_ucs" }
func (Vendor) Requirements() []string { return []string{"REQ-DISC-013"} }

func digest(parts ...string) string {
	sum := sha256.Sum256([]byte(strings.Join(parts, "\x00")))
	return hex.EncodeToString(sum[:])
}

func serial(prefix string, parts ...string) string {
	return prefix + strings.ToUpper(digest(parts...)[:11-len(prefix)])
}

func uuidOf(parts ...string) string {
	h := digest(parts...)
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}

func mac(parts ...string) string {
	h := strings.ToUpper(digest(parts...))
	return "00:25:B5:" + h[0:2] + ":" + h[2:4] + ":" + h[4:6]
}

// attrs is one managed object: its class and attributes in the order UCSM writes them.
type mo struct {
	class string
	attrs [][2]string
}

func (m mo) xml() string {
	var b strings.Builder
	b.WriteString("<" + m.class)
	for _, a := range m.attrs {
		b.WriteString(" " + a[0] + `="`)
		_ = xml.EscapeText(&b, []byte(a[1]))
		b.WriteString(`"`)
	}
	b.WriteString("/>")
	return b.String()
}

func (m mo) get(k string) string {
	for _, a := range m.attrs {
		if a[0] == k {
			return a[1]
		}
	}
	return ""
}

type server struct {
	dn, profile, cimcIP string
	blade               bool
	chassis, slot       int
	obj                 mo
}

// domain is the seeded UCS domain: every managed object by class, plus the servers for the expectations.
type domain struct {
	classes map[string][]mo
	servers []server
}

func build() *domain {
	d := &domain{classes: map[string][]mo{}}
	add := func(m mo) { d.classes[m.class] = append(d.classes[m.class], m) }
	add(mo{"topSystem", [][2]string{{"dn", "sys"}, {"name", domainName}, {"address", fiPrefix + "10"}, {"mode", "cluster"}, {"site", "RYD"}, {"descr", ""}}})
	for i, id := range []string{"A", "B"} {
		ip := fiPrefix + strconv.Itoa(fiHostBase+i)
		add(mo{"networkElement", [][2]string{{"dn", "sys/switch-" + id}, {"id", id}, {"model", "UCS-FI-6454"}, {"serial", serial("FDO", domainName, id)},
			{"vendor", "Cisco Systems, Inc."}, {"oobIfIp", ip}, {"oobIfMask", "255.255.255.0"}, {"oobIfGw", fiPrefix + "1"}, {"operability", "operable"}, {"thermal", "ok"}}})
		add(mo{"mgmtIf", [][2]string{{"dn", "sys/switch-" + id + "/mgmt/if-1"}, {"extIp", ip}, {"extMask", "255.255.255.0"}, {"mac", mac(domainName, "fi", id)}, {"subject", "sw"}}})
	}
	cimc := cimcHostMin
	for c := 1; c <= chassisCount; c++ {
		cdn := "sys/chassis-" + strconv.Itoa(c)
		add(mo{"equipmentChassis", [][2]string{{"dn", cdn}, {"id", strconv.Itoa(c)}, {"model", "UCSB-5108-AC2"}, {"serial", serial("FOX", domainName, cdn)},
			{"vendor", "Cisco Systems Inc"}, {"operability", "operable"}, {"power", "ok"}, {"thermal", "ok"}}})
		for s := 1; s <= bladesPerChassis; s++ {
			dn := cdn + "/blade-" + strconv.Itoa(s)
			profile := "esx-ryd-ucs-" + strconv.Itoa(c) + strconv.Itoa(s)
			sv := server{dn: dn, profile: profile, cimcIP: cimcPrefix + strconv.Itoa(cimc), blade: true, chassis: c, slot: s}
			cimc++
			sv.obj = mo{"computeBlade", [][2]string{{"dn", dn}, {"chassisId", strconv.Itoa(c)}, {"slotId", strconv.Itoa(s)}, {"model", "UCSB-B200-M6"},
				{"serial", serial("FCH", domainName, dn)}, {"vendor", "Cisco Systems Inc"}, {"uuid", uuidOf(domainName, dn)}, {"originalUuid", uuidOf(domainName, dn, "hw")},
				{"numOfCpus", strconv.Itoa(cpusPerServer)}, {"numOfCores", strconv.Itoa(coresPerServer)}, {"totalMemory", strconv.Itoa(memoryMb)},
				{"operPower", "on"}, {"operability", "operable"}, {"association", "associated"}, {"assignedToDn", "org-root/ls-" + profile}, {"name", ""}}}
			add(sv.obj)
			add(mo{"mgmtIf", [][2]string{{"dn", dn + "/mgmt/if-1"}, {"extIp", sv.cimcIP}, {"extMask", "255.255.255.0"}, {"mac", mac(domainName, dn)}, {"subject", "blade"}}})
			d.servers = append(d.servers, sv)
		}
	}
	for r := 1; r <= rackUnits; r++ {
		dn := "sys/rack-unit-" + strconv.Itoa(r)
		profile, assigned, association := "", "", "none"
		if r == 1 {
			profile, assigned, association = "db-ryd-ucs-01", "org-root/ls-db-ryd-ucs-01", "associated"
		}
		sv := server{dn: dn, profile: profile, cimcIP: cimcPrefix + strconv.Itoa(cimc)}
		cimc++
		sv.obj = mo{"computeRackUnit", [][2]string{{"dn", dn}, {"id", strconv.Itoa(r)}, {"serverId", strconv.Itoa(r)}, {"model", "UCSC-C240-M6SX"},
			{"serial", serial("WZP", domainName, dn)}, {"vendor", "Cisco Systems Inc"}, {"uuid", uuidOf(domainName, dn)},
			{"numOfCpus", strconv.Itoa(cpusPerServer)}, {"numOfCores", strconv.Itoa(coresPerServer)}, {"totalMemory", strconv.Itoa(memoryMb)},
			{"operPower", "on"}, {"operability", "operable"}, {"association", association}, {"assignedToDn", assigned}, {"name", ""}}}
		add(sv.obj)
		add(mo{"mgmtIf", [][2]string{{"dn", dn + "/mgmt/if-1"}, {"extIp", sv.cimcIP}, {"extMask", "255.255.255.0"}, {"mac", mac(domainName, dn)}, {"subject", "rack"}}})
		d.servers = append(d.servers, sv)
	}
	return d
}

var knownClasses = map[string]bool{"topSystem": true, "networkElement": true, "equipmentChassis": true, "computeBlade": true, "computeRackUnit": true, "mgmtIf": true}

type request struct {
	XMLName    xml.Name
	InName     string `xml:"inName,attr"`
	InPassword string `xml:"inPassword,attr"`
	InCookie   string `xml:"inCookie,attr"`
	Cookie     string `xml:"cookie,attr"`
	ClassID    string `xml:"classId,attr"`
}

type sessions struct {
	mu   sync.Mutex
	live map[string]bool
	n    int
}

func fault(method, code, descr string) string {
	return "<" + method + ` cookie="" response="yes" errorCode="` + code + `" invocationResult="unidentified-fail" errorDescr="` + descr + `"></` + method + ">"
}

func (d *domain) handler(env *sim.Env) http.Handler {
	ss := &sessions{live: map[string]bool{}}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/nuova" || r.Method != http.MethodPost {
			sim.NotFound(w)
			return
		}
		body, err := io.ReadAll(io.LimitReader(r.Body, maxBody))
		var req request
		if err != nil || xml.Unmarshal(body, &req) != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		out := ""
		switch req.XMLName.Local {
		case "aaaLogin":
			if req.InName != env.User || req.InPassword != env.Secret {
				out = fault("aaaLogin", errAuth, "Authentication failed")
				break
			}
			ss.mu.Lock()
			ss.n++
			cookie := cookieEpoch + "/" + uuidOf(env.Secret, "ucsm-session", strconv.Itoa(ss.n))
			ss.live[cookie] = true
			ss.mu.Unlock()
			out = `<aaaLogin cookie="" response="yes" outCookie="` + cookie + `" outRefreshPeriod="` + refreshPeriod + `" outPriv="read-only" outDomains="" outChannel="noencssl" outEvtChannel="noencssl" outSessionId="" outVersion="` + ucsmVersion + `" outName="` + env.User + `"></aaaLogin>`
		case "aaaLogout":
			ss.mu.Lock()
			live := ss.live[req.InCookie]
			delete(ss.live, req.InCookie)
			ss.mu.Unlock()
			status := "success"
			if !live {
				status = "failure"
			}
			out = `<aaaLogout cookie="" response="yes" outStatus="` + status + `"></aaaLogout>`
		case "configResolveClass":
			ss.mu.Lock()
			live := ss.live[req.Cookie]
			ss.mu.Unlock()
			switch {
			case !live:
				out = fault("configResolveClass", errAuthz, "Authorization required")
			case !knownClasses[req.ClassID]:
				out = fault("configResolveClass", errClass, "unknown class "+req.ClassID)
			default:
				var b strings.Builder
				b.WriteString(`<configResolveClass dn="" cookie="` + req.Cookie + `" response="yes" classId="` + req.ClassID + `"><outConfigs>`)
				for _, m := range d.classes[req.ClassID] {
					b.WriteString(m.xml())
				}
				b.WriteString("</outConfigs></configResolveClass>")
				out = b.String()
			}
		default:
			out = fault(req.XMLName.Local, errClass, "unknown method")
		}
		sim.WriteRaw(w, http.StatusOK, "text/xml", []byte(out))
	})
}

func (Vendor) Start(_ context.Context, _ *estate.Estate, env *sim.Env) (*sim.Endpoint, error) {
	ep, _, err := sim.ServeHTTPS(env, build().handler(env))
	return ep, err
}

func (Vendor) Runs(_ *estate.Estate, ep *sim.Endpoint, env *sim.Env) []sim.Run {
	d := build()
	run := sim.Run{
		Name:           strings.ToLower(domainName),
		Targets:        []sim.Target{{Kind: "host", Value: ep.URL, Label: domainName}},
		Options:        map[string]any{"verifyTls": true, "caCertPem": env.CA.PEM},
		CredentialType: "password",
		Credential:     &sim.Credential{Type: "password", Fields: map[string]string{"username": env.User, "password": env.Secret}},
	}
	dom := strings.ToLower(domainName)
	x := &run.Expect
	for _, fi := range d.classes["networkElement"] {
		x.CIs = append(x.CIs, sim.ExpectCI{Type: "network_device", Name: dom + " FI-" + fi.get("id"), Identity: map[string]string{"serialNumber": fi.get("serial")}})
	}
	chassisName := map[string]string{}
	for _, ch := range d.classes["equipmentChassis"] {
		name := dom + " chassis " + ch.get("id")
		chassisName[ch.get("id")] = name
		x.CIs = append(x.CIs, sim.ExpectCI{Type: "chassis", Name: name, Identity: map[string]string{"serialNumber": ch.get("serial")}})
	}
	sort.SliceStable(d.servers, func(i, j int) bool { return d.servers[i].dn < d.servers[j].dn })
	for _, s := range d.servers {
		hostName := s.profile
		if hostName == "" {
			hostName = s.dn
		}
		x.CIs = append(x.CIs, sim.ExpectCI{Type: "host", Name: hostName, Identity: map[string]string{"serialNumber": s.obj.get("serial"), "systemUuid": s.obj.get("uuid")}})
		bmc := "CIMC @ " + s.cimcIP
		x.CIs = append(x.CIs, sim.ExpectCI{Type: "bmc", Name: bmc, Identity: map[string]string{"managementIp": s.cimcIP}})
		x.Rel("manages", "bmc", bmc, "host", hostName)
		if s.blade {
			blade := chassisName[strconv.Itoa(s.chassis)] + " slot " + strconv.Itoa(s.slot)
			x.CIs = append(x.CIs, sim.ExpectCI{Type: "blade", Name: blade, Identity: map[string]string{"chassisRef": serialOfChassis(d, s.chassis), "bay": strconv.Itoa(s.slot), "serialNumber": s.obj.get("serial")}})
			x.Rel("contains", "chassis", chassisName[strconv.Itoa(s.chassis)], "blade", blade)
			x.Rel("contains", "blade", blade, "host", hostName)
		}
	}
	return []sim.Run{run}
}

func serialOfChassis(d *domain, id int) string {
	for _, ch := range d.classes["equipmentChassis"] {
		if ch.get("id") == strconv.Itoa(id) {
			return ch.get("serial")
		}
	}
	return ""
}
