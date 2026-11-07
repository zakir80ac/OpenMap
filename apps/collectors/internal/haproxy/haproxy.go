// REQ-DISC-018 — HAProxy collector over the statistics endpoint (`;csv`, optional basic auth):
// frontends become VIP listeners on the load balancer, backends carry balance mode and health, and
// every server line becomes a listening service on the member host with its check status, joined
// by depends_on edges. Column positions are read from the CSV header, so HAProxy 1.8 to 3.x all parse.
package haproxy

import (
	"context"
	"encoding/csv"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/collector"
	"github.com/openmap/openmap/apps/collectors/internal/contract"
	"github.com/openmap/openmap/apps/collectors/internal/restjson"
)

const (
	collectorID  = "haproxy"
	version      = "0.1.0"
	vendor       = "haproxy"
	evidenceKind = "api_response"
	httpTimeout  = 30 * time.Second
	optionPath   = "statsPath" // default from HAProxy's conventional `stats uri /stats`
	optionVerify = "verifyTls"
	optionCA     = "caCertPem"
	defaultPath  = "/stats"
	csvSuffix    = ";csv"
	credUser     = "username"
	credPassword = "password"
	defaultVrf   = "default"
	svFrontend   = "FRONTEND"
	svBackend    = "BACKEND"
	// frontendSuffix keeps a `listen` section's frontend identity apart from its backend pool's.
	frontendSuffix = "#frontend"

	typeLB       = "load_balancer"
	typeListener = "listening_service"
	typeIP       = "ip_address"
	relContains  = "contains"
	relDependsOn = "depends_on"
	relUsesIP    = "uses_ip"
)

type Collector struct{}

func (Collector) Manifest() contract.Manifest {
	return contract.Manifest{
		ID: collectorID, Family: "load_balancer", Version: version, Language: "go",
		Protocols: []string{"http", "https"}, CredentialTypes: []string{"none", "password"},
		TargetKinds: []string{"host", "url"}, Emits: []string{typeLB, typeListener, typeIP},
		ContractVersion: contract.Version,
	}
}

// Row is one statistics line with the columns the collector uses.
type Row struct {
	Proxy, Server, Status, Mode, Algo, Addr, CheckStatus            string
	Weight, Current, Max, Limit, Total, BytesIn, BytesOut, Downtime int64
	Type                                                            int // 0 frontend, 1 backend, 2 server, 3 socket/listener
}

// Parse reads the stats CSV.
func Parse(text string) ([]Row, error) {
	text = strings.TrimPrefix(strings.TrimSpace(text), "# ")
	r := csv.NewReader(strings.NewReader(text))
	r.FieldsPerRecord = -1
	records, err := r.ReadAll()
	if err != nil {
		return nil, err
	}
	if len(records) < 1 {
		return nil, nil
	}
	col := map[string]int{}
	for i, name := range records[0] {
		col[strings.TrimSpace(name)] = i
	}
	get := func(rec []string, name string) string {
		i, ok := col[name]
		if !ok || i >= len(rec) {
			return ""
		}
		return rec[i]
	}
	num := func(rec []string, name string) int64 {
		n, _ := strconv.ParseInt(get(rec, name), 10, 64)
		return n
	}
	var rows []Row
	for _, rec := range records[1:] {
		if len(rec) < 2 || rec[0] == "" {
			continue
		}
		rows = append(rows, Row{
			Proxy: get(rec, "pxname"), Server: get(rec, "svname"), Status: get(rec, "status"), Mode: get(rec, "mode"), Algo: get(rec, "algo"), Addr: get(rec, "addr"), CheckStatus: get(rec, "check_status"),
			Weight: num(rec, "weight"), Current: num(rec, "scur"), Max: num(rec, "smax"), Limit: num(rec, "slim"), Total: num(rec, "stot"), BytesIn: num(rec, "bin"), BytesOut: num(rec, "bout"), Downtime: num(rec, "downtime"), Type: int(num(rec, "type")),
		})
	}
	return rows, nil
}

// Fetch downloads the CSV from the stats endpoint. A non-empty caPem pins the chain to that private CA bundle
// (option caCertPem), as the REST collectors do through restjson.TransportFor.
func Fetch(ctx context.Context, target string, path string, user, password string, verifyTLS bool, caPem string) ([]byte, string, error) {
	base := target
	if !strings.Contains(base, "://") {
		base = "http://" + base
	}
	u := strings.TrimSuffix(base, "/") + path + csvSuffix
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, "", err
	}
	if user != "" {
		req.SetBasicAuth(user, password)
	}
	// Stats pages commonly sit behind self-signed certificates; verifyTls=true or caCertPem enforce the chain.
	transport, err := restjson.TransportFor(verifyTLS, caPem)
	if err != nil {
		return nil, "", err
	}
	client := &http.Client{Timeout: httpTimeout, Transport: transport}
	res, err := client.Do(req)
	if err != nil {
		return nil, "", err
	}
	defer res.Body.Close()
	body, err := io.ReadAll(res.Body)
	if err != nil {
		return nil, "", err
	}
	switch {
	case res.StatusCode == http.StatusUnauthorized || res.StatusCode == http.StatusForbidden:
		return nil, "", collector.Errorf(contract.ErrAuthFailed, false, "%s rejected the stats credential (%d)", target, res.StatusCode)
	case res.StatusCode >= http.StatusBadRequest:
		return nil, "", collector.Errorf(contract.ErrUnsupportedDevice, false, "%s returned %d for %s", target, res.StatusCode, path)
	}
	return body, res.Header.Get("Server"), nil
}

func splitAddr(addr string) (string, int) {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return addr, 0
	}
	p, _ := strconv.Atoi(port)
	return host, p
}

func stateOf(status string) string {
	s := strings.ToUpper(status)
	switch {
	case strings.HasPrefix(s, "UP"), s == "OPEN":
		return "up"
	case strings.HasPrefix(s, "DOWN"):
		return "down"
	case strings.HasPrefix(s, "MAINT"), s == "DRAIN":
		return "maintenance"
	case s == "NOLB":
		return "no-lb"
	default:
		return strings.ToLower(status)
	}
}

// Emit converts rows into observations.
func Emit(rows []Row, target contract.Target, serverHeader string, raw []byte, at time.Time) collector.Observation {
	obs := collector.Observation{Evidence: []collector.RawEvidence{{Kind: evidenceKind, Data: raw}}}
	host, _ := splitAddr(strings.TrimPrefix(strings.TrimPrefix(target.Value, "https://"), "http://"))
	lbRef := strings.ToLower(host)
	lbIdentity := map[string]string{"serialNumber": vendor + ":" + lbRef, "managementIp": lbRef}
	lb := contract.CiRef{Type: typeLB, Identity: lbIdentity}
	frontends, backends, servers := 0, 0, 0
	for _, r := range rows {
		switch r.Server {
		case svFrontend:
			frontends++
		case svBackend:
			backends++
		default:
			servers++
		}
	}
	obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeLB, Identity: lbIdentity, Name: lbRef,
		Attributes: map[string]any{"vendor": vendor, "model": firstNonEmpty(serverHeader, vendor), "frontends": frontends, "backends": backends, "servers": servers, "managementIp": lbRef, "fqdn": lbRef},
		Tags:       []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
	// The stats CSV does not carry the frontend→backend mapping (that lives in haproxy.cfg), so each
	// backend becomes its own pool CI that owns the member edges. A frontend depends on the backend
	// with the same name (`listen` sections, or matching names) or, when the instance has exactly
	// one backend, on that one.
	backendRows := map[string][]Row{}
	backendMeta := map[string]Row{}
	var backendOrder []string
	for _, r := range rows {
		switch r.Server {
		case svBackend:
			backendMeta[r.Proxy] = r
			backendOrder = append(backendOrder, r.Proxy)
		case svFrontend:
		default:
			if r.Type == 2 || r.Addr != "" {
				backendRows[r.Proxy] = append(backendRows[r.Proxy], r)
			}
		}
	}
	backendRef := map[string]contract.CiRef{}
	memberSeen := map[string]bool{}
	for _, name := range backendOrder {
		meta := backendMeta[name]
		proto := firstNonEmpty(meta.Mode, "tcp")
		members := backendRows[name]
		identity := map[string]string{"hostRef": lbRef, "protocol": proto, "port": name}
		pool := contract.CiRef{Type: typeListener, Identity: identity}
		backendRef[name] = pool
		up := 0
		// HAProxy hides server addresses from the stats CSV unless `stats show-legends` is set, so the
		// member names and health always travel on the pool even when no member listener can be keyed.
		// Attribute values are scalars or arrays of scalars (attributesSchema), so members are parallel
		// string arrays: name, "name=state" and "name=address" (address empty when hidden).
		memberNames, memberStates, memberAddrs := []string{}, []string{}, []string{}
		for _, m := range members {
			if stateOf(m.Status) == "up" {
				up++
			}
			memberNames = append(memberNames, m.Server)
			memberStates = append(memberStates, m.Server+"="+stateOf(m.Status))
			memberAddrs = append(memberAddrs, m.Server+"="+m.Addr)
		}
		attrs := map[string]any{"vendor": vendor, "backend": name, "protocol": proto, "role": "backend-pool", "balance": meta.Algo, "state": stateOf(meta.Status), "memberCount": len(members), "membersUp": up, "members": memberNames, "memberStates": memberStates, "memberAddresses": memberAddrs, "sessionsCurrent": meta.Current, "sessionsMax": meta.Max, "sessionsLimit": meta.Limit, "sessionsTotal": meta.Total, "bytesIn": meta.BytesIn, "bytesOut": meta.BytesOut, "downtimeSeconds": meta.Downtime, "source": collectorID}
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeListener, Identity: identity, Name: name + " (backend, " + proto + ")", Attributes: attrs, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
		obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relContains, From: lb, To: pool, Attributes: map[string]any{}, ObservedAt: at})
		for _, m := range members {
			addr, port := splitAddr(m.Addr)
			if addr == "" || port == 0 {
				continue
			}
			mIdentity := map[string]string{"hostRef": strings.ToLower(addr), "protocol": proto, "port": strconv.Itoa(port)}
			mRef := contract.CiRef{Type: typeListener, Identity: mIdentity}
			key := mIdentity["hostRef"] + "|" + proto + "|" + mIdentity["port"]
			if !memberSeen[key] {
				memberSeen[key] = true
				obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeListener, Identity: mIdentity, Name: m.Server + " (" + m.Addr + ")", Attributes: map[string]any{"protocol": proto, "port": port, "address": addr, "poolMemberState": stateOf(m.Status), "checkStatus": m.CheckStatus, "weight": m.Weight, "downtimeSeconds": m.Downtime, "backend": name, "source": collectorID}, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
				if net.ParseIP(addr) != nil {
					ipIdentity := map[string]string{"address": addr, "vrfRef": defaultVrf}
					obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeIP, Identity: ipIdentity, Name: addr, Attributes: map[string]any{"role": "pool-member", "source": collectorID}, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
					obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relUsesIP, From: mRef, To: contract.CiRef{Type: typeIP, Identity: ipIdentity}, Attributes: map[string]any{}, ObservedAt: at})
				}
			}
			obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relDependsOn, From: pool, To: mRef, Attributes: map[string]any{"backend": name, "state": stateOf(m.Status), "weight": m.Weight}, ObservedAt: at})
		}
	}
	for _, r := range rows {
		if r.Server != svFrontend {
			continue
		}
		proto := firstNonEmpty(r.Mode, "tcp")
		identity := map[string]string{"hostRef": lbRef, "protocol": proto, "port": r.Proxy}
		if _, sameName := backendRef[r.Proxy]; sameName {
			// A `listen` section reports a FRONTEND and a BACKEND row under one proxy name; without the
			// suffix both CIs share one identity and the frontend would depend on itself.
			identity["port"] = r.Proxy + frontendSuffix
		}
		vs := contract.CiRef{Type: typeListener, Identity: identity}
		attrs := map[string]any{"vendor": vendor, "frontend": r.Proxy, "protocol": proto, "role": "frontend", "state": stateOf(r.Status), "sessionsCurrent": r.Current, "sessionsMax": r.Max, "sessionsLimit": r.Limit, "sessionsTotal": r.Total, "bytesIn": r.BytesIn, "bytesOut": r.BytesOut, "service": "load-balanced-frontend", "source": collectorID}
		target, linked := backendRef[r.Proxy]
		if !linked && len(backendOrder) == 1 {
			target, linked = backendRef[backendOrder[0]], true
		}
		if linked {
			attrs["backend"] = target.Identity["port"]
		}
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeListener, Identity: identity, Name: r.Proxy + " (frontend, " + proto + ")", Attributes: attrs, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
		obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relContains, From: lb, To: vs, Attributes: map[string]any{}, ObservedAt: at})
		if linked {
			obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relDependsOn, From: vs, To: target, Attributes: map[string]any{"backend": target.Identity["port"]}, ObservedAt: at})
		}
	}
	return obs
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

func (Collector) Collect(ctx context.Context, target contract.Target, cred *contract.Credential, options map[string]any) (collector.Observation, error) {
	path, _ := options[optionPath].(string)
	if path == "" {
		path = defaultPath
	}
	verify, _ := options[optionVerify].(bool)
	caPem, _ := options[optionCA].(string)
	user, password := "", ""
	if cred != nil && cred.Type == "password" {
		user, password = cred.Fields[credUser], cred.Fields[credPassword]
	}
	body, server, err := Fetch(ctx, target.Value, path, user, password, verify, caPem)
	if err != nil {
		if _, ok := err.(*collector.TargetError); ok {
			return collector.Observation{}, err
		}
		return collector.Observation{}, collector.Errorf(contract.ErrUnreachable, true, "%s: %v", target.Value, err)
	}
	rows, err := Parse(string(body))
	if err != nil || len(rows) == 0 {
		return collector.Observation{}, collector.Errorf(contract.ErrParse, false, "%s did not return HAProxy statistics CSV", target.Value)
	}
	return Emit(rows, target, server, body, time.Now().UTC()), nil
}
