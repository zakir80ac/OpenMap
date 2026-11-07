// REQ-QA-005 REQ-DISC-013 — simulated HPE OneView appliance (REST, X-Api-Version header): POST
// /rest/login-sessions returns a sessionID that every later call carries in the Auth header (401
// AUTHN_AUTH_FAIL on a bad password, 401 on a missing or closed session), DELETE /rest/login-sessions closes it,
// and the enclosures, server-hardware, interconnects and server-profiles collections page with start/count and
// nextPageUri. Every HPE ProLiant host in the estate is a rack-mount server-hardware entry (no enclosure), with
// its iLO from the estate bmc (mpModel, mpFirmwareVersion, a link-local and the static mpIpAddresses), serverName
// set to the operating system host name, per-processor processorCoreCount and its NIC ports in portMap. The estate
// has no Synergy frames, so one Synergy 12000 frame with four compute modules and two Virtual Connect modules is
// seeded deterministically from its name; its expectations come from that seeded set.
package oneview

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
)

const (
	hpeManufacturer = "Hewlett Packard Enterprise"
	apiVersion      = "6600"
	defaultCount    = 32 // OneView's page size when a request names no count
	mibPerGiB       = 1024
	frameName       = "SYN-RYD-01"
	frameBays       = 12
	computeModules  = 4
	moduleSockets   = 2
	moduleCores     = 28
	moduleMemoryMb  = 524288
	mpPrefix        = "10.250.20."
	mpHostBase      = 11
	icPrefix        = "10.250.21."
	domainSuffix    = ".bank.local"
)

type Vendor struct{}

func (Vendor) ID() string             { return "hpe-oneview" }
func (Vendor) Collector() string      { return "hpe_oneview" }
func (Vendor) Requirements() []string { return []string{"REQ-DISC-013"} }

func digest(parts ...string) string {
	sum := sha256.Sum256([]byte(strings.Join(parts, "\x00")))
	return hex.EncodeToString(sum[:])
}

func uuidOf(parts ...string) string {
	h := strings.ToUpper(digest(parts...))
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}

func macOf(parts ...string) string {
	h := strings.ToUpper(digest(parts...))
	return "94:40:C9:" + h[0:2] + ":" + h[2:4] + ":" + h[4:6]
}

func nextMac(mac string) string {
	b := strings.Split(mac, ":")
	if len(b) != 6 {
		return mac
	}
	n, err := strconv.ParseUint(b[5], 16, 8)
	if err != nil {
		return mac
	}
	b[5] = strings.ToUpper(strconv.FormatUint((n+1)&0xff, 16))
	if len(b[5]) == 1 {
		b[5] = "0" + b[5]
	}
	return strings.Join(b, ":")
}

// server is one server-hardware entry and what the collector must make of it.
type server struct {
	host     *estate.CI
	bmc      *estate.CI
	doc      map[string]any
	name     string // the host CI name the collector emits (serverName)
	identity map[string]string
	mpModel  string
	mpIP     string
	bay      int
}

type appliance struct {
	enclosures    []any
	servers       []server
	interconnects []any
	profiles      []any
	frame         map[string]any
}

func mpModelOf(product string) string { return strings.ReplaceAll(product, " ", "") }

func shortModel(model string) string { return strings.TrimPrefix(model, "ProLiant ") }

func serverDoc(uri, name, serverName, serial, model, uuid, cpuModel, romVersion, mpModel, mpFw, mpIP, mpHost string, sockets, cores int, memMb int64, macs []string, power string) map[string]any {
	ports := []any{}
	for _, m := range macs {
		ports = append(ports, map[string]any{"mac": m, "type": "Ethernet", "portName": "Port " + strconv.Itoa(len(ports)+1)})
	}
	perProc := 0
	if sockets > 0 {
		perProc = cores / sockets
	}
	return map[string]any{
		"type": "server-hardware-12", "category": "server-hardware", "uri": uri, "name": name, "serverName": serverName,
		"serialNumber": serial, "model": model, "shortModel": shortModel(model), "uuid": uuid, "status": "OK", "state": "Monitored",
		"powerState": power, "processorCount": sockets, "processorCoreCount": perProc, "processorType": cpuModel, "memoryMb": memMb,
		"romVersion": romVersion, "mpModel": mpModel, "mpFirmwareVersion": mpFw, "mpState": "OK",
		"mpHostInfo": map[string]any{"mpHostName": mpHost, "mpIpAddresses": []any{
			map[string]string{"address": "fe80::" + strings.ToLower(digest(serial)[:4]) + ":" + strings.ToLower(digest(serial)[4:8]), "type": "LinkLocal"},
			map[string]string{"address": mpIP, "type": "Static"},
		}},
		"portMap":     map[string]any{"deviceSlots": []any{map[string]any{"deviceName": "HPE Ethernet 10/25Gb 2-port 631FLR-SFP28 Adptr", "slotNumber": 1, "location": "Flb", "physicalPorts": ports}}},
		"locationUri": nil, "position": nil,
	}
}

func build(e *estate.Estate) *appliance {
	a := &appliance{}
	for _, h := range e.OfType("host", func(c *estate.CI) bool { return c.Str("manufacturer") == hpeManufacturer }) {
		bmcs := e.To(h, "manages")
		if len(bmcs) == 0 {
			continue
		}
		b := bmcs[0]
		id := uuidOf("server-hardware", h.ID("serialNumber"))
		uri := "/rest/server-hardware/" + id
		mac := strings.ToUpper(h.ID("primaryMac"))
		power := "On"
		if strings.EqualFold(h.Str("powerState"), "off") {
			power = "Off"
		}
		mpModel := mpModelOf(b.Str("product"))
		mpIP := b.ID("managementIp")
		mpHost := "ilo" + strings.ToLower(h.ID("serialNumber")) + domainSuffix
		doc := serverDoc(uri, mpHost, h.Str("hostname"), h.ID("serialNumber"), h.Str("model"), strings.ToUpper(h.ID("systemUuid")), h.Str("cpuModel"),
			"U54 v"+h.Str("biosVersion"), mpModel, b.Str("firmware"), mpIP, mpHost, int(h.Num("cpuSockets", 2)), int(h.Num("cpuCores", 0)),
			int64(h.Num("memoryGb", 0))*mibPerGiB, []string{mac, nextMac(mac)}, power)
		doc["serverProfileUri"] = "/rest/server-profiles/" + uuidOf("profile", h.ID("serialNumber"))
		a.profiles = append(a.profiles, map[string]any{"type": "ServerProfileV12", "uri": doc["serverProfileUri"], "name": h.Name, "serverHardwareUri": uri, "status": "OK"})
		a.servers = append(a.servers, server{host: h, bmc: b, doc: doc, name: h.Name, mpModel: mpModel, mpIP: mpIP})
	}
	a.seedFrame()
	return a
}

// seedFrame adds the Synergy frame the estate does not have.
func (a *appliance) seedFrame() {
	encURI := "/rest/enclosures/" + uuidOf("enclosure", frameName)
	encSerial := "CZ2" + strings.ToUpper(digest(frameName)[:7])
	a.frame = map[string]any{"type": "EnclosureV8", "category": "enclosures", "uri": encURI, "name": frameName, "serialNumber": encSerial,
		"enclosureType": "SY12000", "enclosureModel": "Synergy 12000 Frame", "partNumber": "797740-B21", "status": "OK", "state": "Configured",
		"deviceBayCount": frameBays, "rackName": "RYD-DH01-B-04", "fwBaselineName": "HPE Synergy Service Pack 2024.11.01"}
	a.enclosures = append(a.enclosures, a.frame)
	for bay := 1; bay <= computeModules; bay++ {
		key := frameName + "/bay-" + strconv.Itoa(bay)
		serial := "CZ3" + strings.ToUpper(digest(key)[:7])
		uri := "/rest/server-hardware/" + uuidOf("server-hardware", serial)
		name := frameName + ", bay " + strconv.Itoa(bay)
		host := "esx-ryd-syn-0" + strconv.Itoa(bay)
		mpIP := mpPrefix + strconv.Itoa(mpHostBase+bay)
		mac := macOf(key)
		doc := serverDoc(uri, name, host, serial, "Synergy 480 Gen10 Plus", uuidOf(key), "Intel(R) Xeon(R) Gold 6330 CPU @ 2.00GHz", "I46 v2.80",
			"iLO5", "3.06", mpIP, "ilo"+strings.ToLower(serial)+domainSuffix, moduleSockets, moduleSockets*moduleCores, moduleMemoryMb, []string{mac, nextMac(mac)}, "On")
		doc["shortModel"] = "SY 480 Gen10 Plus"
		doc["locationUri"] = encURI
		doc["position"] = bay
		doc["serverProfileUri"] = "/rest/server-profiles/" + uuidOf("profile", serial)
		a.profiles = append(a.profiles, map[string]any{"type": "ServerProfileV12", "uri": doc["serverProfileUri"], "name": host, "serverHardwareUri": uri, "status": "OK"})
		a.servers = append(a.servers, server{doc: doc, name: host, mpModel: "iLO5", mpIP: mpIP, bay: bay,
			identity: map[string]string{"serialNumber": serial, "systemUuid": strings.ToLower(uuidOf(key)), "primaryMac": strings.ToLower(mac)}})
	}
	for i, bay := range []int{3, 6} {
		uri := "/rest/interconnects/" + uuidOf("interconnect", frameName, strconv.Itoa(bay))
		a.interconnects = append(a.interconnects, map[string]any{"type": "InterconnectV7", "uri": uri, "name": frameName + ", interconnect " + strconv.Itoa(bay),
			"serialNumber": "TWT" + strings.ToUpper(digest(frameName, "ic", strconv.Itoa(bay))[:7]), "model": "Virtual Connect SE 100Gb F32 Module for Synergy",
			"status": "OK", "state": "Configured", "firmwareVersion": "2.10.0.1004", "enclosureUri": encURI, "interconnectIP": icPrefix + strconv.Itoa(mpHostBase+i),
			"interconnectLocation": map[string]any{"locationEntries": []any{map[string]any{"type": "Enclosure", "value": encURI}, map[string]any{"type": "Bay", "value": strconv.Itoa(bay)}}}})
	}
}

func (a *appliance) collection(name string) []any {
	switch name {
	case "enclosures":
		return a.enclosures
	case "server-hardware":
		out := make([]any, 0, len(a.servers))
		for _, s := range a.servers {
			out = append(out, s.doc)
		}
		return out
	case "interconnects":
		return a.interconnects
	case "server-profiles":
		return a.profiles
	}
	return nil
}

var collectionTypes = map[string]string{"enclosures": "EnclosureCollectionV8", "server-hardware": "server-hardware-list-12", "interconnects": "InterconnectCollectionV7", "server-profiles": "ServerProfileListV12"}

func ovError(w http.ResponseWriter, status int, code, msg string) {
	sim.WriteJSON(w, status, map[string]any{"errorCode": code, "message": msg, "details": "", "recommendedActions": []string{}, "errorSource": nil, "nestedErrors": []any{}, "data": map[string]any{}})
}

func (a *appliance) handler(env *sim.Env) http.Handler {
	var mu sync.Mutex
	live := map[string]bool{}
	n := 0
	authed := func(r *http.Request) bool {
		mu.Lock()
		defer mu.Unlock()
		return live[r.Header.Get("Auth")]
	}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /rest/login-sessions", func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			ovError(w, http.StatusBadRequest, "INVALID_JSON", "The request body is not valid JSON.")
			return
		}
		if body["userName"] != env.User || body["password"] != env.Secret {
			ovError(w, http.StatusUnauthorized, "AUTHN_AUTH_FAIL", "Invalid user name or password.")
			return
		}
		mu.Lock()
		n++
		session := strings.ReplaceAll(env.Token("ov"+strconv.Itoa(n)), "-", "")
		live[session] = true
		mu.Unlock()
		sim.WriteJSON(w, http.StatusOK, map[string]any{"partnerData": map[string]any{}, "sessionID": session})
	})
	mux.HandleFunc("DELETE /rest/login-sessions", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		ok := live[r.Header.Get("Auth")]
		delete(live, r.Header.Get("Auth"))
		mu.Unlock()
		if !ok {
			ovError(w, http.StatusUnauthorized, "AUTHORIZATION", "Authorization error: user session is not valid.")
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("GET /rest/{collection}", func(w http.ResponseWriter, r *http.Request) {
		if !authed(r) {
			ovError(w, http.StatusUnauthorized, "AUTHORIZATION", "Authorization error: user session is not valid.")
			return
		}
		name := r.PathValue("collection")
		all := a.collection(name)
		if _, known := collectionTypes[name]; !known {
			ovError(w, http.StatusNotFound, "RESOURCE_NOT_FOUND", "The resource /rest/"+name+" was not found.")
			return
		}
		start, _ := strconv.Atoi(r.URL.Query().Get("start"))
		count, err := strconv.Atoi(r.URL.Query().Get("count"))
		if err != nil || count <= 0 {
			count = defaultCount
		}
		if start > len(all) || start < 0 {
			start = len(all)
		}
		end := start + count
		if end > len(all) {
			end = len(all)
		}
		base := "/rest/" + name
		var next, prev any
		if end < len(all) {
			next = base + "?start=" + strconv.Itoa(end) + "&count=" + strconv.Itoa(count)
		}
		if start > 0 {
			p := start - count
			if p < 0 {
				p = 0
			}
			prev = base + "?start=" + strconv.Itoa(p) + "&count=" + strconv.Itoa(count)
		}
		sim.WriteJSON(w, http.StatusOK, map[string]any{"type": collectionTypes[name], "category": name, "uri": r.URL.RequestURI(),
			"members": all[start:end], "count": end - start, "total": len(all), "start": start, "nextPageUri": next, "prevPageUri": prev})
	})
	return mux
}

func (Vendor) Start(_ context.Context, e *estate.Estate, env *sim.Env) (*sim.Endpoint, error) {
	ep, _, err := sim.ServeHTTPS(env, build(e).handler(env))
	return ep, err
}

func (Vendor) Runs(e *estate.Estate, ep *sim.Endpoint, env *sim.Env) []sim.Run {
	a := build(e)
	run := sim.Run{
		Name:           "oneview-01",
		Targets:        []sim.Target{{Kind: "host", Value: ep.URL, Label: "oneview-01"}},
		Options:        map[string]any{"verifyTls": true, "caCertPem": env.CA.PEM, "apiVersion": apiVersion},
		CredentialType: "password",
		Credential:     &sim.Credential{Type: "password", Fields: map[string]string{"username": env.User, "password": env.Secret}},
	}
	x := &run.Expect
	frame, _ := a.frame["name"].(string)
	frameSerial, _ := a.frame["serialNumber"].(string)
	x.CIs = append(x.CIs, sim.ExpectCI{Type: "chassis", Name: frame, Identity: map[string]string{"serialNumber": frameSerial}})
	for _, s := range a.servers {
		bmc := s.mpModel + " @ " + s.mpIP
		if s.host != nil {
			x.EstateCI(s.host)
			x.CIs = append(x.CIs, sim.ExpectCI{Type: "bmc", Name: bmc, Identity: s.bmc.Identity})
		} else {
			x.CIs = append(x.CIs, sim.ExpectCI{Type: "host", Name: s.name, Identity: s.identity})
			x.CIs = append(x.CIs, sim.ExpectCI{Type: "bmc", Name: bmc, Identity: map[string]string{"managementIp": s.mpIP}})
			blade := frame + " bay " + strconv.Itoa(s.bay)
			x.CIs = append(x.CIs, sim.ExpectCI{Type: "blade", Name: blade, Identity: map[string]string{"chassisRef": frameSerial, "bay": strconv.Itoa(s.bay), "serialNumber": s.identity["serialNumber"]}})
			x.Rel("contains", "chassis", frame, "blade", blade)
			x.Rel("contains", "blade", blade, "host", s.name)
		}
		x.Rel("manages", "bmc", bmc, "host", s.name)
	}
	for _, ic := range a.interconnects {
		m, _ := ic.(map[string]any)
		name, _ := m["name"].(string)
		sn, _ := m["serialNumber"].(string)
		x.CIs = append(x.CIs, sim.ExpectCI{Type: "network_device", Name: name, Identity: map[string]string{"serialNumber": sn}})
		x.Rel("contains", "chassis", frame, "network_device", name)
	}
	return []sim.Run{run}
}
