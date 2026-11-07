// REQ-QA-005 REQ-DISC-010 — simulated Oracle Cloud Infrastructure: Identity, Core, Database, Container Engine and
// Load Balancer each answer on their own HTTPS listener under the simulated-mode CA, and every request's OCI HTTP
// Signature (draft-cavage signing string over date, (request-target) and host; rsa-sha256; keyId
// tenancy/user/fingerprint) is verified against the public half of an API key generated per process, with the
// fingerprint computed as OCI does (MD5 of the DER public key). Lists page with limit/page and opc-next-page.
//
// The synthetic estate has no OCI data, so the tenancy below is GENERATED deterministically inside the simulator
// (only the API key is per process) and the expectations come from the same set: a network and a prod compartment
// under the tenancy, one VCN with two subnets, four instances (one in the root compartment, one stopped) with
// VNICs and images, a DB system, an OKE cluster and a public load balancer.
package oci

import (
	"context"
	"crypto"
	"crypto/md5" //nolint:gosec // OCI API key fingerprints are MD5 of the DER public key by specification.
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
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
	region       = "me-jeddah-1"
	ad           = "Xyzw:ME-JEDDAH-1-AD-1"
	vcnName      = "prod-vcn"
	vcnDNS       = "prodvcn"
	signedHdrs   = "date (request-target) host"
	keyIdentity  = "identity"
	keyCore      = "core"
	keyDatabase  = "database"
	keyContainer = "containerengine"
	keyLB        = "loadbalancer"
	stateKey     = "privateKeyPem"
	stateFinger  = "fingerprint"
	rsaBits      = 2048
	uniqueLen    = 52
	firstHost    = 10
	lbPort       = 443
	backendPort  = 8443
	dbNodes      = 2
)

type Vendor struct{}

func (Vendor) ID() string             { return "oci" }
func (Vendor) Collector() string      { return "cloud_oci" }
func (Vendor) Requirements() []string { return []string{"REQ-DISC-010"} }

func ocid(kind, regionPart, seed string) string {
	return "ocid1." + kind + ".oc1." + regionPart + ".aaaaaaaa" + cloudsim.Hex("oci-"+kind+seed, uniqueLen)
}

var (
	tenancy = ocid("tenancy", "", "horizon")
	user    = ocid("user", "", "openmap-sim")
)

type compartment struct{ id, name string }

type subnet struct{ id, name, dns, cidr, prefix string }

type image struct{ id, name, os, version string }

type instance struct {
	id, name, compartment, state, subnet, ip, publicIP, vnic string
	img                                                      image
}

type tenancyView struct {
	octet        string
	compartments []compartment
	vcnID        string
	subnets      []subnet
	images       []image
	instances    []instance
	lbIP         string
}

func generate() *tenancyView {
	b := strconv.Itoa(cloudsim.Byte("oci-vcn", 1, 254))
	t := &tenancyView{octet: b, vcnID: ocid("vcn", region, vcnName)}
	network := compartment{ocid("compartment", "", "network"), "network"}
	prod := compartment{ocid("compartment", "", "prod"), "prod"}
	t.compartments = []compartment{network, prod}
	t.subnets = []subnet{
		{ocid("subnet", region, "app"), "app", "app", "10." + b + ".1.0/24", "10." + b + ".1."},
		{ocid("subnet", region, "db"), "db", "db", "10." + b + ".2.0/24", "10." + b + ".2."},
	}
	ol := image{ocid("image", region, "ol9"), "Oracle-Linux-9.4-2026.01.31-0", "Oracle Linux", "9"}
	ubuntu := image{ocid("image", region, "ubuntu"), "Canonical-Ubuntu-22.04-2026.02.10-0", "Canonical Ubuntu", "22.04"}
	t.images = []image{ol, ubuntu}
	public := func(seed string) string {
		return "129.159." + strconv.Itoa(cloudsim.Byte("oci-pub"+seed, 1, 254)) + "." + strconv.Itoa(cloudsim.Byte("oci-pub2"+seed, 1, 254))
	}
	specs := []instance{
		{name: "app-jed-01", compartment: prod.id, state: "RUNNING", img: ol, publicIP: public("app-jed-01")},
		{name: "app-jed-02", compartment: prod.id, state: "RUNNING", img: ol},
		{name: "batch-jed-01", compartment: prod.id, state: "STOPPED", img: ubuntu},
		{name: "bastion-jed-01", compartment: tenancy, state: "RUNNING", img: ubuntu, publicIP: public("bastion")},
	}
	for n, s := range specs {
		s.id = ocid("instance", region, s.name)
		s.vnic = ocid("vnic", region, s.name)
		s.subnet = t.subnets[0].id
		s.ip = t.subnets[0].prefix + strconv.Itoa(firstHost+n)
		t.instances = append(t.instances, s)
	}
	t.lbIP = public("web-lb")
	return t
}

func (t *tenancyView) subnetByID(id string) subnet {
	for _, s := range t.subnets {
		if s.id == id {
			return s
		}
	}
	return subnet{}
}

func (t *tenancyView) fqdn(i instance) string {
	return i.name + "." + t.subnetByID(i.subnet).dns + "." + vcnDNS + ".oraclevcn.com"
}

// list returns the documents of one collection in one compartment.
func (t *tenancyView) list(collection, comp string) ([]any, bool) {
	out := []any{}
	network, prod := t.compartments[0].id, t.compartments[1].id
	switch collection {
	case "instances":
		for _, i := range t.instances {
			if i.compartment == comp {
				out = append(out, map[string]any{"id": i.id, "displayName": i.name, "compartmentId": i.compartment, "availabilityDomain": ad, "region": region,
					"shape": "VM.Standard.E4.Flex", "lifecycleState": i.state, "imageId": i.img.id, "timeCreated": "2026-02-01T10:00:00.000Z",
					"freeformTags": map[string]string{"environment": "prod"}, "shapeConfig": map[string]float64{"ocpus": 2, "memoryInGBs": 32}})
			}
		}
	case "vnicAttachments":
		for _, i := range t.instances {
			if i.compartment == comp {
				out = append(out, map[string]any{"id": ocid("vnicattachment", region, i.name), "instanceId": i.id, "vnicId": i.vnic, "subnetId": i.subnet,
					"compartmentId": comp, "availabilityDomain": ad, "lifecycleState": "ATTACHED"})
			}
		}
	case "vcns":
		if comp == network {
			out = append(out, map[string]any{"id": t.vcnID, "displayName": vcnName, "cidrBlock": "10." + t.octet + ".0.0/16", "dnsLabel": vcnDNS, "compartmentId": network, "lifecycleState": "AVAILABLE"})
		}
	case "subnets":
		if comp == network {
			for _, s := range t.subnets {
				out = append(out, map[string]any{"id": s.id, "displayName": s.name, "cidrBlock": s.cidr, "vcnId": t.vcnID, "dnsLabel": s.dns, "compartmentId": network, "prohibitPublicIpOnVnic": s.name == "db", "lifecycleState": "AVAILABLE"})
			}
		}
	case "dbSystems":
		if comp == prod {
			out = append(out, map[string]any{"id": ocid("dbsystem", region, "ledger"), "displayName": "ledger-db", "hostname": "ledgerdb", "domain": "db." + vcnDNS + ".oraclevcn.com",
				"shape": "VM.Standard2.4", "databaseEdition": "ENTERPRISE_EDITION_HIGH_PERFORMANCE", "version": "19.22.0.0", "lifecycleState": "AVAILABLE", "nodeCount": dbNodes,
				"subnetId": t.subnets[1].id, "compartmentId": prod})
		}
	case "clusters":
		if comp == prod {
			out = append(out, map[string]any{"id": ocid("cluster", region, "payments"), "name": "payments-oke", "kubernetesVersion": "v1.32.1", "lifecycleState": "ACTIVE",
				"vcnId": t.vcnID, "compartmentId": prod, "endpoints": map[string]string{"privateEndpoint": "10." + t.octet + ".1.5:6443"}})
		}
	case "loadBalancers":
		if comp == prod {
			out = append(out, map[string]any{"id": ocid("loadbalancer", region, "web"), "displayName": "web-lb", "shapeName": "flexible", "lifecycleState": "ACTIVE", "isPrivate": false,
				"compartmentId": prod, "ipAddresses": []any{map[string]any{"ipAddress": t.lbIP, "isPublic": true}},
				"listeners":   map[string]any{"https": map[string]any{"name": "https", "port": lbPort, "protocol": "HTTP", "defaultBackendSetName": "web"}},
				"backendSets": map[string]any{"web": map[string]any{"policy": "ROUND_ROBIN", "backends": []any{map[string]any{"ipAddress": t.instances[0].ip, "port": backendPort, "offline": false}, map[string]any{"ipAddress": t.instances[1].ip, "port": backendPort, "offline": false}}}}})
		}
	default:
		return nil, false
	}
	return out, true
}

func ociError(w http.ResponseWriter, r *http.Request, status int, code, message string) {
	w.Header().Set("opc-request-id", strings.ToUpper(cloudsim.Hex("oci-req"+r.URL.RequestURI(), 32)))
	sim.WriteJSON(w, status, map[string]string{"code": code, "message": message})
}

// verifySignature checks the request against the OCI HTTP Signature profile for a GET.
func verifySignature(r *http.Request, pub *rsa.PublicKey, keyID string, now time.Time) string {
	auth := r.Header.Get("Authorization")
	if !strings.HasPrefix(auth, "Signature ") {
		return "The required information to complete authentication was not provided."
	}
	params := map[string]string{}
	for _, part := range strings.Split(strings.TrimPrefix(auth, "Signature "), ",") {
		k, v, ok := strings.Cut(strings.TrimSpace(part), "=")
		if ok {
			params[k] = strings.Trim(v, `"`)
		}
	}
	if params["version"] != "1" || params["algorithm"] != "rsa-sha256" || params["keyId"] != keyID {
		return "The required information to complete authentication was not provided or was incorrect."
	}
	headers := strings.Fields(params["headers"])
	required := map[string]bool{}
	for _, h := range strings.Fields(signedHdrs) {
		required[h] = true
	}
	var lines []string
	for _, h := range headers {
		delete(required, h)
		switch h {
		case "(request-target)":
			lines = append(lines, h+": "+strings.ToLower(r.Method)+" "+r.URL.RequestURI())
		case "host":
			lines = append(lines, "host: "+r.Host)
		default:
			lines = append(lines, h+": "+r.Header.Get(h))
		}
	}
	if len(required) > 0 {
		return "Signature must cover date, (request-target) and host."
	}
	at, err := http.ParseTime(r.Header.Get("Date"))
	if err != nil || !cloudsim.WithinSkew(at, now) {
		return "Date header is missing or outside the allowed clock skew."
	}
	sig, err := base64.StdEncoding.DecodeString(params["signature"])
	digest := sha256.Sum256([]byte(strings.Join(lines, "\n")))
	if err != nil || rsa.VerifyPKCS1v15(pub, crypto.SHA256, digest[:], sig) != nil {
		return "The signature does not match the request."
	}
	return ""
}

func fingerprint(pub *rsa.PublicKey) (string, error) {
	der, err := x509.MarshalPKIXPublicKey(pub)
	if err != nil {
		return "", err
	}
	sum := md5.Sum(der) //nolint:gosec // see import
	h := hex.EncodeToString(sum[:])
	parts := make([]string, 0, len(sum))
	for i := 0; i < len(h); i += 2 {
		parts = append(parts, h[i:i+2])
	}
	return strings.Join(parts, ":"), nil
}

// routes maps each service listener to its API version prefix and collections.
var routes = map[string]struct {
	prefix      string
	collections []string
}{
	keyIdentity:  {"/20160918", []string{"compartments"}},
	keyCore:      {"/20160918", []string{"instances", "vnicAttachments", "vcns", "subnets", "vnics", "images"}},
	keyDatabase:  {"/20160918", []string{"dbSystems"}},
	keyContainer: {"/20180222", []string{"clusters"}},
	keyLB:        {"/20170115", []string{"loadBalancers"}},
}

func (t *tenancyView) handler(service string, pub *rsa.PublicKey, keyID string) http.Handler {
	route := routes[service]
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if msg := verifySignature(r, pub, keyID, time.Now()); msg != "" {
			ociError(w, r, http.StatusUnauthorized, "NotAuthenticated", msg)
			return
		}
		rest := strings.TrimPrefix(r.URL.Path, route.prefix+"/")
		collection, id, _ := strings.Cut(rest, "/")
		served := false
		for _, c := range route.collections {
			served = served || c == collection
		}
		if r.Method != http.MethodGet || !strings.HasPrefix(r.URL.Path, route.prefix+"/") || !served {
			ociError(w, r, http.StatusNotFound, "NotAuthorizedOrNotFound", "Authorization failed or requested resource not found.")
			return
		}
		w.Header().Set("opc-request-id", strings.ToUpper(cloudsim.Hex("oci-req"+r.URL.RequestURI(), 32)))
		if id != "" {
			t.get(w, r, collection, id)
			return
		}
		q := r.URL.Query()
		var all []any
		if collection == "compartments" {
			if q.Get("compartmentId") != tenancy || q.Get("compartmentIdInSubtree") != "true" || q.Get("accessLevel") != "ANY" {
				ociError(w, r, http.StatusBadRequest, "InvalidParameter", "compartmentIdInSubtree requires the tenancy and accessLevel ANY.")
				return
			}
			for _, c := range t.compartments {
				all = append(all, map[string]any{"id": c.id, "compartmentId": tenancy, "name": c.name, "description": c.name + " workloads", "lifecycleState": "ACTIVE"})
			}
		} else {
			var ok bool
			if all, ok = t.list(collection, q.Get("compartmentId")); !ok || q.Get("compartmentId") == "" {
				ociError(w, r, http.StatusBadRequest, "MissingParameter", "compartmentId is required.")
				return
			}
		}
		offset, ok := cloudsim.Offset(q.Get("page"))
		if !ok {
			ociError(w, r, http.StatusBadRequest, "InvalidParameter", "Invalid page token.")
			return
		}
		start, end, next := cloudsim.Window(len(all), offset, cloudsim.Size(q.Get("limit")))
		if next != "" {
			w.Header().Set("opc-next-page", next)
		}
		sim.WriteJSON(w, http.StatusOK, all[start:end])
	})
}

func (t *tenancyView) get(w http.ResponseWriter, r *http.Request, collection, id string) {
	switch collection {
	case "vnics":
		for _, i := range t.instances {
			if i.vnic == id {
				doc := map[string]any{"id": i.vnic, "subnetId": i.subnet, "privateIp": i.ip, "hostnameLabel": i.name, "macAddress": "02:00:17:" + strings.ToUpper(cloudsim.Hex("oci-mac"+i.name, 2)+":"+cloudsim.Hex("oci-mac2"+i.name, 2)+":"+cloudsim.Hex("oci-mac3"+i.name, 2)),
					"isPrimary": true, "lifecycleState": "AVAILABLE", "availabilityDomain": ad}
				if i.publicIP != "" {
					doc["publicIp"] = i.publicIP
				}
				sim.WriteJSON(w, http.StatusOK, doc)
				return
			}
		}
	case "images":
		for _, img := range t.images {
			if img.id == id {
				sim.WriteJSON(w, http.StatusOK, map[string]any{"id": img.id, "displayName": img.name, "operatingSystem": img.os, "operatingSystemVersion": img.version, "lifecycleState": "AVAILABLE"})
				return
			}
		}
	}
	ociError(w, r, http.StatusNotFound, "NotAuthorizedOrNotFound", "Authorization failed or requested resource not found.")
}

func (Vendor) Start(_ context.Context, _ *estate.Estate, env *sim.Env) (*sim.Endpoint, error) {
	key, err := rsa.GenerateKey(rand.Reader, rsaBits)
	if err != nil {
		return nil, err
	}
	fp, err := fingerprint(&key.PublicKey)
	if err != nil {
		return nil, err
	}
	t := generate()
	keyID := tenancy + "/" + user + "/" + fp
	ep, err := sim.ServeEach(env, []string{keyIdentity, keyCore, keyDatabase, keyContainer, keyLB}, true, func(k string) http.Handler { return t.handler(k, &key.PublicKey, keyID) })
	if err != nil {
		return nil, err
	}
	ep.State[stateKey] = string(pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)}))
	ep.State[stateFinger] = fp
	return ep, nil
}

func (Vendor) Runs(_ *estate.Estate, ep *sim.Endpoint, env *sim.Env) []sim.Run {
	t := generate()
	keyPem, _ := ep.State[stateKey].(string)
	fp, _ := ep.State[stateFinger].(string)
	run := sim.Run{
		Name:    "tenancy",
		Targets: []sim.Target{{Kind: "account", Value: tenancy, Label: "horizon tenancy"}},
		Options: map[string]any{"identityUrl": ep.Devices[keyIdentity], "coreUrl": ep.Devices[keyCore], "databaseUrl": ep.Devices[keyDatabase],
			"containerEngineUrl": ep.Devices[keyContainer], "loadBalancerUrl": ep.Devices[keyLB], "caCertPem": env.CA.PEM},
		CredentialType: "api_key",
		Credential:     &sim.Credential{Type: "api_key", Fields: map[string]string{"tenancyOcid": tenancy, "userOcid": user, "fingerprint": fp, "privateKeyPem": keyPem}},
	}
	x := &run.Expect
	x.CI("cloud_account", tenancy)
	names := map[string]string{}
	for _, c := range t.compartments {
		names[c.id] = c.name
		x.CI("cloud_resource", c.name)
		x.Rel("member_of", "cloud_resource", c.name, "cloud_account", tenancy)
	}
	x.CI("cloud_resource", vcnName)
	x.Rel("member_of", "cloud_resource", vcnName, "cloud_account", tenancy)
	for _, s := range t.subnets {
		x.CI("subnet", vcnName+"/"+s.name)
		x.Rel("member_of", "subnet", vcnName+"/"+s.name, "cloud_resource", vcnName)
	}
	for _, i := range t.instances {
		x.CIs = append(x.CIs, sim.ExpectCI{Type: "vm", Name: i.name, Identity: map[string]string{"instanceUuid": i.id, "fqdn": t.fqdn(i)}})
		x.Rel("member_of", "vm", i.name, "cloud_account", tenancy)
		if c, ok := names[i.compartment]; ok {
			x.Rel("member_of", "vm", i.name, "cloud_resource", c)
		}
		x.CI("ip_address", i.ip)
		x.Rel("uses_ip", "vm", i.name, "ip_address", i.ip)
		x.Rel("in_subnet", "ip_address", i.ip, "subnet", vcnName+"/"+t.subnetByID(i.subnet).name)
		if i.publicIP != "" {
			x.CI("ip_address", i.publicIP)
			x.Rel("uses_ip", "vm", i.name, "ip_address", i.publicIP)
		}
		osName := i.img.os + " " + i.img.version
		x.CI("operating_system", osName)
		x.Rel("installed_on", "operating_system", osName, "vm", i.name)
	}
	x.CI("database_cluster", "ledger-db")
	x.Rel("member_of", "database_cluster", "ledger-db", "cloud_account", tenancy)
	x.Rel("runs_on", "database_cluster", "ledger-db", "subnet", vcnName+"/db")
	x.CI("cloud_resource", "payments-oke")
	x.Rel("member_of", "cloud_resource", "payments-oke", "cloud_account", tenancy)
	x.Rel("runs_on", "cloud_resource", "payments-oke", "cloud_resource", vcnName)
	x.CI("load_balancer", "web-lb")
	x.CI("ip_address", t.lbIP)
	x.Rel("member_of", "load_balancer", "web-lb", "cloud_account", tenancy)
	x.Rel("uses_ip", "load_balancer", "web-lb", "ip_address", t.lbIP)
	return []sim.Run{run}
}
