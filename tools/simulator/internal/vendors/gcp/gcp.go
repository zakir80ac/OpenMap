// REQ-QA-005 REQ-DISC-010 — simulated Google Cloud: the OAuth 2.0 token endpoint verifies the service account's
// RS256 JWT assertion (RFC 7523) against the public half of a key generated per process (issuer, audience, scope,
// iat/exp window), then Compute Engine (aggregated instances, subnetworks and forwarding rules; global networks),
// Cloud SQL Admin and GKE answer on their own HTTPS listeners under the simulated-mode CA with bearer checks and
// pageToken paging.
//
// The synthetic estate has no Google Cloud data, so the project below is GENERATED deterministically inside the
// simulator (no randomness per run; only the signing key is per process) and the expectations come from the same
// set: one VPC network with two subnetworks in me-central2, five instances across three zones (one stopped, one
// Windows, one with an external NAT address), an internal load balancer forwarding rule, a Cloud SQL PostgreSQL
// instance and a GKE cluster.
package gcp

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/openmap/openmap/tools/simulator/internal/estate"
	"github.com/openmap/openmap/tools/simulator/internal/sim"
	"github.com/openmap/openmap/tools/simulator/internal/vendors/cloudsim"
)

const (
	project      = "horizon-bank-prod" // generated project id
	region       = "me-central2"
	network      = "vpc-prod"
	scope        = "https://www.googleapis.com/auth/cloud-platform.read-only"
	selfBase     = "https://www.googleapis.com/compute/v1/projects/" + project
	licenseBase  = "https://www.googleapis.com/compute/v1/projects/"
	grantType    = "urn:ietf:params:oauth:grant-type:jwt-bearer"
	keyOAuth     = "oauth2"
	keyCompute   = "compute"
	keySQL       = "sqladmin"
	keyContainer = "container"
	stateKey     = "privateKeyPem"
	rsaBits      = 2048
	maxLifetime  = 3600
	tokenTTL     = 3599
	idDigits     = 19
	gkeNodes     = 3
	firstHost    = 2 // GCE reserves .0, .1 (gateway) and the last two addresses of a subnet
	lbHost       = 250
	sqlHost      = 5
	gkeHost      = 2
	jwtParts     = 3
)

type Vendor struct{}

func (Vendor) ID() string             { return "gcp" }
func (Vendor) Collector() string      { return "cloud_gcp" }
func (Vendor) Requirements() []string { return []string{"REQ-DISC-010"} }

func clientEmail(env *sim.Env) string { return env.User + "@" + project + ".iam.gserviceaccount.com" }

type subnet struct {
	name, cidr, prefix string
}

type instance struct {
	name, zone, status, subnet, license, natIP, ip string
}

type world struct {
	octet     string
	subnets   []subnet
	instances []instance
	lbIP      string
	sqlIP     string
}

func numericID(seed string) string { return cloudsim.Digits("gcp-id"+seed, idDigits) }

func generate() *world {
	b := strconv.Itoa(cloudsim.Byte("gcp-"+project, 1, 254))
	w := &world{octet: b}
	w.subnets = []subnet{{"app", "10." + b + ".1.0/24", "10." + b + ".1."}, {"data", "10." + b + ".2.0/24", "10." + b + ".2."}}
	ubuntu := licenseBase + "ubuntu-os-cloud/global/licenses/ubuntu-2204-lts"
	windows := licenseBase + "windows-cloud/global/licenses/windows-server-2022-dc"
	specs := []instance{
		{name: "app-01", zone: region + "-a", status: "RUNNING", subnet: "app", license: ubuntu, natIP: "34.166." + strconv.Itoa(cloudsim.Byte("gcp-nat", 1, 254)) + "." + strconv.Itoa(cloudsim.Byte("gcp-nat2", 1, 254))},
		{name: "app-02", zone: region + "-b", status: "RUNNING", subnet: "app", license: ubuntu},
		{name: "batch-01", zone: region + "-c", status: "TERMINATED", subnet: "app", license: ubuntu},
		{name: "db-proxy-01", zone: region + "-a", status: "RUNNING", subnet: "data", license: ubuntu},
		{name: "win-jump-01", zone: region + "-b", status: "RUNNING", subnet: "data", license: windows},
	}
	hosts := map[string]int{}
	for _, s := range specs {
		hosts[s.subnet]++
		for _, sn := range w.subnets {
			if sn.name == s.subnet {
				s.ip = sn.prefix + strconv.Itoa(firstHost-1+hosts[s.subnet])
			}
		}
		w.instances = append(w.instances, s)
	}
	w.lbIP = w.subnets[0].prefix + strconv.Itoa(lbHost)
	w.sqlIP = w.subnets[1].prefix + strconv.Itoa(sqlHost)
	return w
}

func zones() []string { return []string{region + "-a", region + "-b", region + "-c"} }

func networkLink() string { return selfBase + "/global/networks/" + network }

func subnetLink(name string) string { return selfBase + "/regions/" + region + "/subnetworks/" + name }

type scoped struct {
	scope string
	item  any
}

func (w *world) aggregated(kind string) []scoped {
	var out []scoped
	switch kind {
	case "instances":
		for _, i := range w.instances {
			nic := map[string]any{"name": "nic0", "network": networkLink(), "subnetwork": subnetLink(i.subnet), "networkIP": i.ip, "stackType": "IPV4_ONLY"}
			if i.natIP != "" {
				nic["accessConfigs"] = []any{map[string]string{"type": "ONE_TO_ONE_NAT", "name": "External NAT", "natIP": i.natIP, "networkTier": "PREMIUM"}}
			}
			out = append(out, scoped{"zones/" + i.zone, map[string]any{
				"kind": "compute#instance", "id": numericID(i.name), "name": i.name, "zone": selfBase + "/zones/" + i.zone,
				"machineType": selfBase + "/zones/" + i.zone + "/machineTypes/n2-standard-4", "status": i.status, "cpuPlatform": "Intel Cascade Lake",
				"labels": map[string]string{"environment": "prod"}, "creationTimestamp": "2026-03-01T08:00:00.000-08:00",
				"networkInterfaces": []any{nic},
				"disks":             []any{map[string]any{"boot": true, "deviceName": i.name, "diskSizeGb": "50", "licenses": []string{i.license}}},
				"selfLink":          selfBase + "/zones/" + i.zone + "/instances/" + i.name,
			}})
		}
	case "subnetworks":
		for _, s := range w.subnets {
			out = append(out, scoped{"regions/" + region, map[string]any{"kind": "compute#subnetwork", "id": numericID("subnet" + s.name), "name": s.name,
				"region": selfBase + "/regions/" + region, "network": networkLink(), "ipCidrRange": s.cidr, "selfLink": subnetLink(s.name)}})
		}
	case "forwardingRules":
		out = append(out, scoped{"regions/" + region, map[string]any{"kind": "compute#forwardingRule", "id": numericID("fr-app-ilb"), "name": "app-ilb",
			"region": selfBase + "/regions/" + region, "IPAddress": w.lbIP, "IPProtocol": "TCP", "ports": []string{"443"}, "loadBalancingScheme": "INTERNAL",
			"backendService": selfBase + "/regions/" + region + "/backendServices/app-backend", "network": networkLink(), "subnetwork": subnetLink("app")}})
	}
	return out
}

func apiError(w http.ResponseWriter, status int, reason, message string) {
	sim.WriteJSON(w, status, map[string]any{"error": map[string]any{"code": status, "message": message, "status": reason}})
}

func page(w http.ResponseWriter, r *http.Request) (offset, size int, ok bool) {
	offset, ok = cloudsim.Offset(r.URL.Query().Get("pageToken"))
	if !ok {
		apiError(w, http.StatusBadRequest, "INVALID_ARGUMENT", "Invalid value for field 'pageToken'.")
	}
	return offset, cloudsim.Size(r.URL.Query().Get("maxResults")), ok
}

func (wd *world) compute(env *sim.Env) http.Handler {
	token := env.Token("gcp")
	mux := http.NewServeMux()
	prefix := "/compute/v1/projects/" + project
	mux.HandleFunc("GET "+prefix+"/aggregated/{kind}", func(w http.ResponseWriter, r *http.Request) {
		if !sim.BearerOK(r, token) {
			apiError(w, http.StatusUnauthorized, "UNAUTHENTICATED", "Request had invalid authentication credentials.")
			return
		}
		kind := r.PathValue("kind")
		all := wd.aggregated(kind)
		if all == nil && kind != "forwardingRules" {
			apiError(w, http.StatusNotFound, "NOT_FOUND", "The requested URL was not found.")
			return
		}
		offset, size, ok := page(w, r)
		if !ok {
			return
		}
		start, end, next := cloudsim.Window(len(all), offset, size)
		items := map[string]map[string]any{}
		for _, s := range all[start:end] {
			if items[s.scope] == nil {
				items[s.scope] = map[string]any{kind: []any{}}
			}
			items[s.scope][kind] = append(items[s.scope][kind].([]any), s.item)
		}
		scopes := []string{"regions/" + region}
		if kind == "instances" {
			scopes = nil
			for _, z := range zones() {
				scopes = append(scopes, "zones/"+z)
			}
		}
		for _, sc := range scopes {
			if items[sc] == nil {
				items[sc] = map[string]any{"warning": map[string]string{"code": "NO_RESULTS_ON_PAGE", "message": "There are no results for scope '" + sc + "' on this page."}}
			}
		}
		doc := map[string]any{"kind": "compute#" + kind + "AggregatedList", "id": prefix + "/aggregated/" + kind, "items": items, "selfLink": selfBase + "/aggregated/" + kind}
		if next != "" {
			doc["nextPageToken"] = next
		}
		sim.WriteJSON(w, http.StatusOK, doc)
	})
	mux.HandleFunc("GET "+prefix+"/global/networks", func(w http.ResponseWriter, r *http.Request) {
		if !sim.BearerOK(r, token) {
			apiError(w, http.StatusUnauthorized, "UNAUTHENTICATED", "Request had invalid authentication credentials.")
			return
		}
		if _, _, ok := page(w, r); !ok {
			return
		}
		sim.WriteJSON(w, http.StatusOK, map[string]any{"kind": "compute#networkList", "items": []any{map[string]any{"kind": "compute#network", "id": numericID("net" + network),
			"name": network, "selfLink": networkLink(), "autoCreateSubnetworks": false, "subnetworks": []string{subnetLink("app"), subnetLink("data")}}}})
	})
	return mux
}

func (wd *world) sqladmin(env *sim.Env) http.Handler {
	token := env.Token("gcp")
	mux := http.NewServeMux()
	mux.HandleFunc("GET /sql/v1beta4/projects/"+project+"/instances", func(w http.ResponseWriter, r *http.Request) {
		if !sim.BearerOK(r, token) {
			apiError(w, http.StatusUnauthorized, "UNAUTHENTICATED", "Request had invalid authentication credentials.")
			return
		}
		sim.WriteJSON(w, http.StatusOK, map[string]any{"kind": "sql#instancesList", "items": []any{map[string]any{"kind": "sql#instance", "name": "ledger-pg",
			"databaseVersion": "POSTGRES_16", "region": region, "state": "RUNNABLE", "connectionName": project + ":" + region + ":ledger-pg",
			"settings":    map[string]string{"tier": "db-custom-4-16384", "availabilityType": "REGIONAL"},
			"ipAddresses": []any{map[string]string{"ipAddress": wd.sqlIP, "type": "PRIVATE"}}}}})
	})
	return mux
}

func (wd *world) container(env *sim.Env) http.Handler {
	token := env.Token("gcp")
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/projects/"+project+"/locations/-/clusters", func(w http.ResponseWriter, r *http.Request) {
		if !sim.BearerOK(r, token) {
			apiError(w, http.StatusUnauthorized, "UNAUTHENTICATED", "Request had invalid authentication credentials.")
			return
		}
		sim.WriteJSON(w, http.StatusOK, map[string]any{"clusters": []any{map[string]any{"id": cloudsim.Hex("gke-payments", 32), "name": "payments-gke",
			"location": region, "status": "RUNNING", "currentMasterVersion": "1.32.4-gke.1415000", "currentNodeCount": gkeNodes,
			"endpoint": "10." + wd.octet + ".8." + strconv.Itoa(gkeHost), "network": network, "subnetwork": "app"}}})
	})
	return mux
}

func b64json(seg string, out any) bool {
	raw, err := base64.RawURLEncoding.DecodeString(seg)
	return err == nil && json.Unmarshal(raw, out) == nil
}

// verifyAssertion checks an RS256 service-account JWT the way Google's token endpoint does.
func verifyAssertion(assertion string, pub *rsa.PublicKey, iss, aud string, now time.Time) string {
	parts := strings.Split(assertion, ".")
	if len(parts) != jwtParts {
		return "Invalid JWT: Token must be a short-lived token and in a reasonable timeframe."
	}
	var header struct {
		Alg string `json:"alg"`
	}
	var claims struct {
		Iss   string `json:"iss"`
		Scope string `json:"scope"`
		Aud   string `json:"aud"`
		Iat   int64  `json:"iat"`
		Exp   int64  `json:"exp"`
	}
	if !b64json(parts[0], &header) || header.Alg != "RS256" || !b64json(parts[1], &claims) {
		return "Invalid JWT header or claim set."
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	digest := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	if err != nil || rsa.VerifyPKCS1v15(pub, crypto.SHA256, digest[:], sig) != nil {
		return "Invalid JWT Signature."
	}
	switch {
	case claims.Iss != iss:
		return "Invalid issuer: the service account is not known."
	case claims.Aud != aud:
		return "Invalid JWT: audience must be the token endpoint."
	case claims.Scope != scope:
		return "Invalid OAuth scope or ID token audience provided."
	case !cloudsim.WithinSkew(time.Unix(claims.Iat, 0), now) || claims.Exp <= now.Unix() || claims.Exp-claims.Iat > maxLifetime:
		return "Invalid JWT: Token must be a short-lived token (60 minutes) and in a reasonable timeframe."
	}
	return ""
}

func (Vendor) Start(_ context.Context, _ *estate.Estate, env *sim.Env) (*sim.Endpoint, error) {
	key, err := rsa.GenerateKey(rand.Reader, rsaBits)
	if err != nil {
		return nil, err
	}
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return nil, err
	}
	wd := generate()
	var ep *sim.Endpoint
	oauth := http.NewServeMux()
	oauth.HandleFunc("POST /token", func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil || r.PostForm.Get("grant_type") != grantType {
			sim.WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "unsupported_grant_type", "error_description": "Invalid grant_type."})
			return
		}
		if msg := verifyAssertion(r.PostForm.Get("assertion"), &key.PublicKey, clientEmail(env), ep.Devices[keyOAuth]+"/token", time.Now()); msg != "" {
			sim.WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_grant", "error_description": msg})
			return
		}
		sim.WriteJSON(w, http.StatusOK, map[string]any{"access_token": env.Token("gcp"), "expires_in": tokenTTL, "token_type": "Bearer"})
	})
	handlers := map[string]http.Handler{keyOAuth: oauth, keyCompute: wd.compute(env), keySQL: wd.sqladmin(env), keyContainer: wd.container(env)}
	ep, err = sim.ServeEach(env, []string{keyOAuth, keyCompute, keySQL, keyContainer}, true, func(k string) http.Handler { return handlers[k] })
	if err != nil {
		return nil, err
	}
	ep.State[stateKey] = string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}))
	return ep, nil
}

func (Vendor) Runs(_ *estate.Estate, ep *sim.Endpoint, env *sim.Env) []sim.Run {
	wd := generate()
	keyPem, _ := ep.State[stateKey].(string)
	run := sim.Run{
		Name:    project,
		Targets: []sim.Target{{Kind: "account", Value: project, Label: project}},
		Options: map[string]any{"tokenUrl": ep.Devices[keyOAuth] + "/token", "scope": scope, "computeUrl": ep.Devices[keyCompute],
			"sqlAdminUrl": ep.Devices[keySQL], "containerUrl": ep.Devices[keyContainer], "caCertPem": env.CA.PEM},
		CredentialType: "service_account",
		Credential:     &sim.Credential{Type: "service_account", Fields: map[string]string{"clientEmail": clientEmail(env), "privateKeyPem": keyPem}},
	}
	x := &run.Expect
	x.CI("cloud_account", project)
	x.CI("cloud_resource", network)
	x.Rel("member_of", "cloud_resource", network, "cloud_account", project)
	for _, s := range wd.subnets {
		x.CI("subnet", network+"/"+s.name)
		x.Rel("member_of", "subnet", network+"/"+s.name, "cloud_resource", network)
	}
	for _, i := range wd.instances {
		x.CI("vm", i.name)
		x.CI("ip_address", i.ip)
		x.Rel("member_of", "vm", i.name, "cloud_account", project)
		x.Rel("uses_ip", "vm", i.name, "ip_address", i.ip)
		x.Rel("in_subnet", "ip_address", i.ip, "subnet", network+"/"+i.subnet)
		if i.natIP != "" {
			x.CI("ip_address", i.natIP)
			x.Rel("uses_ip", "vm", i.name, "ip_address", i.natIP)
		}
		osName := i.license[strings.LastIndex(i.license, "/")+1:]
		x.CI("operating_system", osName)
		x.Rel("installed_on", "operating_system", osName, "vm", i.name)
	}
	x.CI("load_balancer", "app-ilb")
	x.CI("ip_address", wd.lbIP)
	x.Rel("member_of", "load_balancer", "app-ilb", "cloud_account", project)
	x.Rel("uses_ip", "load_balancer", "app-ilb", "ip_address", wd.lbIP)
	x.CI("database_cluster", "ledger-pg")
	x.CI("ip_address", wd.sqlIP)
	x.Rel("member_of", "database_cluster", "ledger-pg", "cloud_account", project)
	x.Rel("uses_ip", "database_cluster", "ledger-pg", "ip_address", wd.sqlIP)
	x.CI("cloud_resource", "payments-gke")
	x.Rel("member_of", "cloud_resource", "payments-gke", "cloud_account", project)
	x.Rel("runs_on", "cloud_resource", "payments-gke", "cloud_resource", network)
	return []sim.Run{run}
}
