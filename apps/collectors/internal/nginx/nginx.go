// REQ-DISC-018 — NGINX collector: NGINX Plus exposes the REST API (`/api/<version>`: nginx facts,
// http server zones, upstreams with per-server health), open-source NGINX exposes only stub_status
// (connection and request counters). Plus upstreams become backend pools with depends_on edges to
// their member servers; both variants emit the load balancer with the counters they expose.
package nginx

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/collector"
	"github.com/openmap/openmap/apps/collectors/internal/contract"
	"github.com/openmap/openmap/apps/collectors/internal/restjson"
)

const (
	collectorID   = "nginx"
	version       = "0.1.0"
	vendor        = "nginx"
	evidenceKind  = "api_response"
	optionAPIPath = "apiPath"    // NGINX Plus `location /api { api; }` prefix
	optionStatus  = "statusPath" // open-source `location /stub_status { stub_status; }`
	optionVerify  = "verifyTls"
	optionCA      = "caCertPem"
	defaultAPI    = "/api"
	defaultStatus = "/stub_status"
	defaultPort   = 80
	credUser      = "username"
	credPassword  = "password"
	defaultVrf    = "default"
	// frontendSuffix keeps a server zone's identity apart from the upstream it is named after.
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

// Facts is the NGINX Plus `/api/<v>/nginx` document.
type Facts struct {
	Version       string `json:"version"`
	Build         string `json:"build"`
	Address       string `json:"address"`
	Generation    int    `json:"generation"`
	LoadTimestamp string `json:"load_timestamp"`
	Timestamp     string `json:"timestamp"`
	PID           int    `json:"pid"`
	PPID          int    `json:"ppid"`
}

// Peer is one upstream server in the Plus API.
type Peer struct {
	ID           int    `json:"id"`
	Server       string `json:"server"`
	Name         string `json:"name"`
	Backup       bool   `json:"backup"`
	Weight       int    `json:"weight"`
	State        string `json:"state"`
	Active       int64  `json:"active"`
	Requests     int64  `json:"requests"`
	Downtime     int64  `json:"downtime"`
	HealthChecks struct {
		Checks    int64 `json:"checks"`
		Fails     int64 `json:"fails"`
		Unhealthy int64 `json:"unhealthy"`
	} `json:"health_checks"`
}

// Upstream is one `/api/<v>/http/upstreams` entry.
type Upstream struct {
	Peers   []Peer `json:"peers"`
	Zone    string `json:"zone"`
	Zombies int    `json:"zombies"`
}

// ServerZone is one `/api/<v>/http/server_zones` entry.
type ServerZone struct {
	Processing int64 `json:"processing"`
	Requests   int64 `json:"requests"`
	Discarded  int64 `json:"discarded"`
	Received   int64 `json:"received"`
	Sent       int64 `json:"sent"`
	Responses  struct {
		Total int64 `json:"total"`
	} `json:"responses"`
}

// StubStatus carries the open-source counters.
type StubStatus struct {
	Active, Accepts, Handled, Requests, Reading, Writing, Waiting int64
}

// Inventory is everything gathered from one instance.
type Inventory struct {
	Plus      bool
	Facts     Facts
	Upstreams map[string]Upstream
	Zones     map[string]ServerZone
	Stub      *StubStatus
	Raw       [][]byte
}

var stubPattern = regexp.MustCompile(`(?s)Active connections:\s*(\d+).*?(\d+)\s+(\d+)\s+(\d+)\s*Reading:\s*(\d+)\s*Writing:\s*(\d+)\s*Waiting:\s*(\d+)`)

// ParseStubStatus parses the stub_status text page.
func ParseStubStatus(text string) (*StubStatus, bool) {
	m := stubPattern.FindStringSubmatch(text)
	if m == nil {
		return nil, false
	}
	n := func(i int) int64 { v, _ := strconv.ParseInt(m[i], 10, 64); return v }
	return &StubStatus{Active: n(1), Accepts: n(2), Handled: n(3), Requests: n(4), Reading: n(5), Writing: n(6), Waiting: n(7)}, true
}

// WalkPlus reads the Plus API; the version list tells which API version the instance serves.
func WalkPlus(ctx context.Context, c *restjson.Client, apiPath string) (*Inventory, error) {
	var versions []int
	if err := c.Get(ctx, strings.TrimSuffix(apiPath, "/")+"/", &versions); err != nil {
		return nil, err
	}
	if len(versions) == 0 {
		return nil, collector.Errorf(contract.ErrUnsupportedDevice, false, "%s lists no API versions", c.Base.Host)
	}
	latest := versions[0]
	for _, v := range versions {
		if v > latest {
			latest = v
		}
	}
	base := strings.TrimSuffix(apiPath, "/") + "/" + strconv.Itoa(latest)
	inv := &Inventory{Plus: true, Upstreams: map[string]Upstream{}, Zones: map[string]ServerZone{}}
	if err := c.Get(ctx, base+"/nginx", &inv.Facts); err != nil {
		return nil, err
	}
	if err := c.Get(ctx, base+"/http/upstreams", &inv.Upstreams); err != nil && !restjson.IsNotFound(err) {
		return nil, err
	}
	if err := c.Get(ctx, base+"/http/server_zones", &inv.Zones); err != nil && !restjson.IsNotFound(err) {
		return nil, err
	}
	inv.Raw = c.Raw()
	return inv, nil
}

// FetchStub downloads stub_status over the same TLS policy as the API client: verifyTls, and the job's
// private CA bundle (caPem) when one is pinned.
func FetchStub(ctx context.Context, c *restjson.Client, user, password, path string, verify bool, caPem string) ([]byte, string, error) {
	rel, err := url.Parse(path)
	if err != nil {
		return nil, "", err
	}
	u := c.Base.ResolveReference(rel)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, "", err
	}
	if user != "" {
		req.SetBasicAuth(user, password)
	}
	transport, err := restjson.TransportFor(verify, caPem)
	if err != nil {
		return nil, "", err
	}
	client := &http.Client{Timeout: stubTimeout, Transport: transport}
	res, err := client.Do(req)
	if err != nil {
		return nil, "", restjson.Classify(u.Host, err)
	}
	defer res.Body.Close()
	body, err := io.ReadAll(res.Body)
	if err != nil {
		return nil, "", restjson.Classify(u.Host, err)
	}
	switch {
	case res.StatusCode == http.StatusUnauthorized || res.StatusCode == http.StatusForbidden:
		return nil, "", collector.Errorf(contract.ErrAuthFailed, false, "%s rejected the credential (%d)", u.Host, res.StatusCode)
	case res.StatusCode >= http.StatusBadRequest:
		return nil, "", collector.Errorf(contract.ErrUnsupportedDevice, false, "%s returned %d for %s", u.Host, res.StatusCode, path)
	}
	return body, res.Header.Get("Server"), nil
}

const stubTimeout = 30 * time.Second

func splitAddr(addr string) (string, int) {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return addr, 0
	}
	p, _ := strconv.Atoi(port)
	return host, p
}

// Emit converts an inventory into observations.
func Emit(inv *Inventory, target contract.Target, serverHeader string, at time.Time) collector.Observation {
	obs := collector.Observation{}
	for _, r := range inv.Raw {
		obs.Evidence = append(obs.Evidence, collector.RawEvidence{Kind: evidenceKind, Data: r})
	}
	host, _ := splitAddr(strings.TrimPrefix(strings.TrimPrefix(target.Value, "https://"), "http://"))
	host = strings.TrimSuffix(host, "/")
	lbRef := strings.ToLower(host)
	lbIdentity := map[string]string{"serialNumber": vendor + ":" + lbRef, "managementIp": lbRef}
	lb := contract.CiRef{Type: typeLB, Identity: lbIdentity}
	attrs := map[string]any{"vendor": vendor, "managementIp": lbRef, "fqdn": lbRef, "edition": "open-source", "model": firstNonEmpty(serverHeader, vendor)}
	if inv.Plus {
		attrs["edition"] = "plus"
		attrs["version"] = inv.Facts.Version
		attrs["build"] = inv.Facts.Build
		attrs["address"] = inv.Facts.Address
		attrs["generation"] = inv.Facts.Generation
		attrs["loadTimestamp"] = inv.Facts.LoadTimestamp
		attrs["upstreams"] = len(inv.Upstreams)
		attrs["serverZones"] = len(inv.Zones)
		attrs["model"] = "nginx-plus " + inv.Facts.Version
	}
	if inv.Stub != nil {
		attrs["activeConnections"] = inv.Stub.Active
		attrs["acceptedConnections"] = inv.Stub.Accepts
		attrs["handledConnections"] = inv.Stub.Handled
		attrs["requests"] = inv.Stub.Requests
		attrs["reading"] = inv.Stub.Reading
		attrs["writing"] = inv.Stub.Writing
		attrs["waiting"] = inv.Stub.Waiting
	}
	obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeLB, Identity: lbIdentity, Name: lbRef, Attributes: attrs, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
	zoneNames := sortedKeys(inv.Zones)
	for _, name := range zoneNames {
		z := inv.Zones[name]
		identity := zoneIdentity(lbRef, name, inv.Upstreams)
		vs := contract.CiRef{Type: typeListener, Identity: identity}
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeListener, Identity: identity, Name: name + " (server zone)", Attributes: map[string]any{"vendor": vendor, "role": "frontend", "serverZone": name, "protocol": "http", "processing": z.Processing, "requests": z.Requests, "discarded": z.Discarded, "bytesIn": z.Received, "bytesOut": z.Sent, "responses": z.Responses.Total, "service": "load-balanced-frontend", "source": collectorID}, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
		obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relContains, From: lb, To: vs, Attributes: map[string]any{}, ObservedAt: at})
	}
	memberSeen := map[string]bool{}
	for _, name := range sortedKeys(inv.Upstreams) {
		u := inv.Upstreams[name]
		identity := map[string]string{"hostRef": lbRef, "protocol": "http", "port": name}
		pool := contract.CiRef{Type: typeListener, Identity: identity}
		up := 0
		for _, p := range u.Peers {
			if p.State == "up" {
				up++
			}
		}
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeListener, Identity: identity, Name: name + " (upstream)", Attributes: map[string]any{"vendor": vendor, "role": "backend-pool", "upstream": name, "zone": u.Zone, "protocol": "http", "memberCount": len(u.Peers), "membersUp": up, "zombies": u.Zombies, "source": collectorID}, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
		obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relContains, From: lb, To: pool, Attributes: map[string]any{}, ObservedAt: at})
		// A server zone whose name matches the upstream (the `listen`/`proxy_pass` convention) depends on it;
		// otherwise a single-upstream instance ties every zone to that upstream.
		for _, zone := range zoneNames {
			if zone == name || len(inv.Upstreams) == 1 {
				obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relDependsOn, From: contract.CiRef{Type: typeListener, Identity: zoneIdentity(lbRef, zone, inv.Upstreams)}, To: pool, Attributes: map[string]any{"upstream": name}, ObservedAt: at})
			}
		}
		for _, p := range u.Peers {
			addr, port := splitAddr(p.Server)
			if addr == "" || port == 0 {
				continue
			}
			mIdentity := map[string]string{"hostRef": strings.ToLower(addr), "protocol": "http", "port": strconv.Itoa(port)}
			mRef := contract.CiRef{Type: typeListener, Identity: mIdentity}
			key := mIdentity["hostRef"] + "|" + mIdentity["port"]
			if !memberSeen[key] {
				memberSeen[key] = true
				obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeListener, Identity: mIdentity, Name: firstNonEmpty(p.Name, p.Server), Attributes: map[string]any{"protocol": "http", "port": port, "address": addr, "poolMemberState": p.State, "backup": p.Backup, "weight": p.Weight, "activeConnections": p.Active, "requests": p.Requests, "downtimeMs": p.Downtime, "healthChecks": p.HealthChecks.Checks, "healthCheckFails": p.HealthChecks.Fails, "upstream": name, "source": collectorID}, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
				if net.ParseIP(addr) != nil {
					ipIdentity := map[string]string{"address": addr, "vrfRef": defaultVrf}
					obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeIP, Identity: ipIdentity, Name: addr, Attributes: map[string]any{"role": "pool-member", "source": collectorID}, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
					obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relUsesIP, From: mRef, To: contract.CiRef{Type: typeIP, Identity: ipIdentity}, Attributes: map[string]any{}, ObservedAt: at})
				}
			}
			obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relDependsOn, From: pool, To: mRef, Attributes: map[string]any{"upstream": name, "state": p.State, "weight": p.Weight, "backup": p.Backup}, ObservedAt: at})
		}
	}
	return obs
}

// zoneIdentity keys a server zone's listener. A zone named after its upstream (the convention the
// depends_on edge follows) would otherwise share the upstream pool's identity and depend on itself, so it
// takes frontendSuffix, as the HAProxy collector does for a `listen` section's frontend.
func zoneIdentity(lbRef, zone string, upstreams map[string]Upstream) map[string]string {
	port := zone
	if _, clash := upstreams[zone]; clash {
		port += frontendSuffix
	}
	return map[string]string{"hostRef": lbRef, "protocol": "http", "port": port}
}

func sortedKeys[T any](m map[string]T) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	for i := 1; i < len(keys); i++ {
		for j := i; j > 0 && keys[j] < keys[j-1]; j-- {
			keys[j], keys[j-1] = keys[j-1], keys[j]
		}
	}
	return keys
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
	user, password := "", ""
	if cred != nil && cred.Type == "password" {
		user, password = cred.Fields[credUser], cred.Fields[credPassword]
	}
	verify := restjson.BoolOption(options, optionVerify)
	caPem := restjson.StringOption(options, optionCA)
	opts := restjson.Options{VerifyTLS: verify, CAPem: caPem}
	base := target.Value
	if !strings.Contains(base, "://") {
		base = "http://" + base // stub_status and the Plus API are commonly served on the plain status port
	}
	c, err := restjson.New(base, defaultPort, restjson.Auth{User: user, Pass: password}, opts)
	if err != nil {
		return collector.Observation{}, err
	}
	apiPath := firstNonEmpty(restjson.StringOption(options, optionAPIPath), defaultAPI)
	statusPath := firstNonEmpty(restjson.StringOption(options, optionStatus), defaultStatus)
	inv, err := WalkPlus(ctx, c, apiPath)
	if err != nil {
		// Open-source NGINX answers /api with a 404 or its default HTML site (a parse error); either way fall
		// through to stub_status. Anything else (auth, transport) is the real answer.
		var te *collector.TargetError
		if !restjson.IsNotFound(err) && !(errors.As(err, &te) && te.Code == contract.ErrParse) {
			return collector.Observation{}, restjson.Classify(target.Value, err)
		}
		inv = &Inventory{Upstreams: map[string]Upstream{}, Zones: map[string]ServerZone{}}
	}
	body, server, err := FetchStub(ctx, c, user, password, statusPath, verify, caPem)
	if err == nil {
		if stub, ok := ParseStubStatus(string(body)); ok {
			inv.Stub = stub
			inv.Raw = append(inv.Raw, body)
		}
	} else if !inv.Plus {
		return collector.Observation{}, restjson.Classify(target.Value, err)
	}
	if !inv.Plus && inv.Stub == nil {
		return collector.Observation{}, collector.Errorf(contract.ErrUnsupportedDevice, false, "%s serves neither the NGINX Plus API at %s nor stub_status at %s", target.Value, apiPath, statusPath)
	}
	if !inv.Plus {
		inv.Raw = append(inv.Raw, body)
	}
	return Emit(inv, target, server, time.Now().UTC()), nil
}
