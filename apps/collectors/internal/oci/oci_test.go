// T-071 REQ-DISC-010 — Identity, Core, Database, Container Engine and Load Balancer APIs served by httptest with the
// OCI HTTP Signature verified against the test key on every request: compartment subtree, paged instances
// (opc-next-page), VNICs with private and public addresses, VCN DNS-derived fqdn, image-derived OS, DB system,
// OKE cluster and load balancer emissions.
package oci

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

var signatureRe = regexp.MustCompile(`signature="([^"]+)"`)

func testKey(t *testing.T) (*rsa.PrivateKey, string) {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	return key, string(pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)}))
}

func server(t *testing.T, pub *rsa.PublicKey) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	wrap := func(h http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			auth := r.Header.Get("Authorization")
			if !strings.Contains(auth, `keyId="ocid1.tenancy.oc1..t/ocid1.user.oc1..u/aa:bb:cc"`) || !strings.Contains(auth, `headers="date (request-target) host"`) {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			m := signatureRe.FindStringSubmatch(auth)
			sig, _ := base64.StdEncoding.DecodeString(m[1])
			// The server sees the request without the scheme/host in URL; rebuild what the client signed.
			r.URL.Host = r.Host
			digest := sha256.Sum256([]byte(SigningString(r, r.Header.Get("Date"))))
			if err := rsa.VerifyPKCS1v15(pub, crypto.SHA256, digest[:], sig); err != nil {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			h(w, r)
		}
	}
	mux.HandleFunc("/20160918/compartments", wrap(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("compartmentIdInSubtree") != "true" {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		_, _ = w.Write([]byte(`[{"id":"ocid1.compartment.oc1..prod","name":"prod","description":"Production","lifecycleState":"ACTIVE"}]`))
	}))
	mux.HandleFunc("/20160918/instances", wrap(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("compartmentId") != "ocid1.compartment.oc1..prod" {
			_, _ = w.Write([]byte(`[]`))
			return
		}
		if r.URL.Query().Get("page") == "" {
			w.Header().Set("opc-next-page", "p2")
			_, _ = w.Write([]byte(`[{"id":"ocid1.instance.oc1.me-jeddah-1.a","displayName":"app-jed-01","compartmentId":"ocid1.compartment.oc1..prod","availabilityDomain":"XYZ:ME-JEDDAH-1-AD-1","region":"me-jeddah-1","shape":"VM.Standard.E4.Flex","lifecycleState":"RUNNING","imageId":"ocid1.image.oc1..ol9","timeCreated":"2026-02-01T10:00:00Z","freeformTags":{"tier":"app"},"shapeConfig":{"ocpus":2,"memoryInGBs":32}}]`))
			return
		}
		_, _ = w.Write([]byte(`[{"id":"ocid1.instance.oc1.me-jeddah-1.b","displayName":"app-jed-02","compartmentId":"ocid1.compartment.oc1..prod","availabilityDomain":"XYZ:ME-JEDDAH-1-AD-1","shape":"VM.Standard.E4.Flex","lifecycleState":"STOPPED","imageId":"ocid1.image.oc1..ol9"}]`))
	}))
	mux.HandleFunc("/20160918/vnicAttachments", wrap(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("compartmentId") != "ocid1.compartment.oc1..prod" {
			_, _ = w.Write([]byte(`[]`))
			return
		}
		_, _ = w.Write([]byte(`[{"instanceId":"ocid1.instance.oc1.me-jeddah-1.a","vnicId":"ocid1.vnic.oc1..a","lifecycleState":"ATTACHED"},{"instanceId":"ocid1.instance.oc1.me-jeddah-1.b","vnicId":"ocid1.vnic.oc1..b","lifecycleState":"DETACHED"}]`))
	}))
	mux.HandleFunc("/20160918/vnics/ocid1.vnic.oc1..a", wrap(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"id":"ocid1.vnic.oc1..a","subnetId":"ocid1.subnet.oc1..app","privateIp":"10.70.1.21","publicIp":"129.159.1.9","hostnameLabel":"app-jed-01","macAddress":"02:00:17:00:AA:BB","isPrimary":true}`))
	}))
	mux.HandleFunc("/20160918/vcns", wrap(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("compartmentId") != "ocid1.compartment.oc1..prod" {
			_, _ = w.Write([]byte(`[]`))
			return
		}
		_, _ = w.Write([]byte(`[{"id":"ocid1.vcn.oc1..prod","displayName":"prod-vcn","cidrBlock":"10.70.0.0/16","dnsLabel":"prodvcn","compartmentId":"ocid1.compartment.oc1..prod"}]`))
	}))
	mux.HandleFunc("/20160918/subnets", wrap(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("compartmentId") != "ocid1.compartment.oc1..prod" {
			_, _ = w.Write([]byte(`[]`))
			return
		}
		_, _ = w.Write([]byte(`[{"id":"ocid1.subnet.oc1..app","displayName":"app","cidrBlock":"10.70.1.0/24","vcnId":"ocid1.vcn.oc1..prod","dnsLabel":"app","prohibitPublicIpOnVnic":false}]`))
	}))
	mux.HandleFunc("/20160918/images/ocid1.image.oc1..ol9", wrap(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"id":"ocid1.image.oc1..ol9","displayName":"Oracle-Linux-9.4-2026.01.31-0","operatingSystem":"Oracle Linux","operatingSystemVersion":"9"}`))
	}))
	mux.HandleFunc("/20160918/dbSystems", wrap(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("compartmentId") != "ocid1.compartment.oc1..prod" {
			_, _ = w.Write([]byte(`[]`))
			return
		}
		_, _ = w.Write([]byte(`[{"id":"ocid1.dbsystem.oc1..ledger","displayName":"ledger-db","hostname":"ledgerdb","domain":"db.prodvcn.oraclevcn.com","shape":"VM.Standard2.4","databaseEdition":"ENTERPRISE_EDITION_HIGH_PERFORMANCE","version":"19.22.0.0","lifecycleState":"AVAILABLE","nodeCount":2,"subnetId":"ocid1.subnet.oc1..app"}]`))
	}))
	mux.HandleFunc("/20180222/clusters", wrap(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("compartmentId") != "ocid1.compartment.oc1..prod" {
			_, _ = w.Write([]byte(`[]`))
			return
		}
		_, _ = w.Write([]byte(`[{"id":"ocid1.cluster.oc1..pay","name":"payments-oke","kubernetesVersion":"v1.32.1","lifecycleState":"ACTIVE","vcnId":"ocid1.vcn.oc1..prod","endpoints":{"privateEndpoint":"10.70.0.5:6443"}}]`))
	}))
	mux.HandleFunc("/20170115/loadBalancers", wrap(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("compartmentId") != "ocid1.compartment.oc1..prod" {
			_, _ = w.Write([]byte(`[]`))
			return
		}
		_, _ = w.Write([]byte(`[{"id":"ocid1.loadbalancer.oc1..web","displayName":"web-lb","shapeName":"flexible","lifecycleState":"ACTIVE","isPrivate":false,"ipAddresses":[{"ipAddress":"129.159.2.2","isPublic":true}],"listeners":{"https":{"port":443,"protocol":"HTTP"}},"backendSets":{"web":{"policy":"ROUND_ROBIN","backends":[{"ipAddress":"10.70.1.21","port":8443,"offline":false},{"ipAddress":"10.70.1.22","port":8443,"offline":true}]}}}]`))
	}))
	return httptest.NewServer(mux)
}

func TestWalkAndEmit(t *testing.T) {
	key, pemKey := testKey(t)
	srv := server(t, &key.PublicKey)
	defer srv.Close()
	cred := &contract.Credential{Type: credType, Fields: map[string]string{credTenancy: "ocid1.tenancy.oc1..t", credUser: "ocid1.user.oc1..u", credFinger: "aa:bb:cc", credKey: pemKey}}
	options := map[string]any{optionIdentity: srv.URL, optionCore: srv.URL, optionDatabase: srv.URL, optionContainer: srv.URL, optionLB: srv.URL}
	obs, err := Collector{}.Collect(context.Background(), contract.Target{Kind: "account", Value: "ocid1.tenancy.oc1..t"}, cred, options)
	if err != nil {
		t.Fatal(err)
	}
	types := map[string]int{}
	byName := map[string]contract.ObservedCi{}
	for _, ci := range obs.Cis {
		types[ci.Type]++
		byName[ci.Name] = ci
	}
	// resources: compartment, vcn, oke cluster
	if types[typeAccount] != 1 || types[typeResource] != 3 || types[typeVM] != 2 || types[typeSubnet] != 1 || types[typeOS] != 2 || types[typeDBClust] != 1 || types[typeLB] != 1 {
		t.Fatalf("unexpected CI mix: %+v", types)
	}
	// ips: private + public for app-jed-01, LB VIP
	if types[typeIP] != 3 {
		t.Fatalf("expected 3 addresses, got %d", types[typeIP])
	}
	vm := byName["app-jed-01"]
	if vm.Identity["fqdn"] != "app-jed-01.app.prodvcn.oraclevcn.com" || vm.Identity["hypervisorRef"] != "oci:xyz:me-jeddah-1-ad-1" || vm.Attributes["health"] != "healthy" || vm.Attributes["ocpus"] != 2.0 {
		t.Fatalf("vm wrong: %+v", vm)
	}
	if byName["app-jed-02"].Attributes["health"] != "down" || byName["app-jed-02"].Identity["fqdn"] != "app-jed-02" {
		t.Fatalf("stopped vm wrong: %+v", byName["app-jed-02"])
	}
	if byName["Oracle Linux 9"].Identity["family"] != "linux" || byName["prod-vcn/app"].Identity["cidr"] != "10.70.1.0/24" {
		t.Fatalf("os or subnet wrong")
	}
	if byName["ledger-db"].Attributes["fqdn"] != "ledgerdb.db.prodvcn.oraclevcn.com" || byName["payments-oke"].Attributes["kubernetesVersion"] != "v1.32.1" || byName["web-lb"].Identity["managementIp"] != "129.159.2.2" {
		t.Fatalf("managed services wrong")
	}
	sets := byName["web-lb"].Attributes["backendSets"].([]map[string]any)
	if len(sets) != 1 || sets[0]["online"] != 1 || sets[0]["members"] != 2 {
		t.Fatalf("backend sets wrong: %+v", sets)
	}
	rels := map[string]int{}
	for _, r := range obs.Relationships {
		rels[r.Type]++
	}
	if rels[relInSubnet] != 1 || rels[relInstalled] != 2 || rels[relRunsOn] != 2 || rels[relUsesIP] != 3 {
		t.Fatalf("relationship mix wrong: %+v", rels)
	}
}

func TestSignatureRejected(t *testing.T) {
	key, pemKey := testKey(t)
	other, _ := rsa.GenerateKey(rand.Reader, 2048)
	srv := server(t, &other.PublicKey)
	defer srv.Close()
	_ = key
	cred := &contract.Credential{Type: credType, Fields: map[string]string{credTenancy: "ocid1.tenancy.oc1..t", credUser: "ocid1.user.oc1..u", credFinger: "aa:bb:cc", credKey: pemKey}}
	_, err := Collector{}.Collect(context.Background(), contract.Target{Kind: "account", Value: "ocid1.tenancy.oc1..t"}, cred, map[string]any{optionIdentity: srv.URL, optionCore: srv.URL})
	if err == nil || !strings.Contains(err.Error(), contract.ErrAuthFailed) {
		t.Fatalf("expected auth_failed for a key the server does not trust, got %v", err)
	}
	if _, err := NewSigner("t", "u", "f", "garbage"); err == nil {
		t.Fatal("garbage key must fail")
	}
	if _, err := (Collector{}).Collect(context.Background(), contract.Target{Kind: "account", Value: "x"}, cred, map[string]any{}); err == nil || !strings.Contains(err.Error(), optionIdentity) {
		t.Fatalf("expected the missing options to be named, got %v", err)
	}
	_ = time.Now()
}
