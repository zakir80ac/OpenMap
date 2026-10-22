// T-070 REQ-DISC-010 — the OAuth token endpoint and the Compute, Cloud SQL and GKE APIs served by httptest: the
// JWT assertion is verified with the test key's public half, pagination and aggregated scopes are followed, and the
// emitted account, networks, subnets, VMs with addresses and OS, load balancer, SQL cluster and GKE cluster are checked.
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
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

func testKey(t *testing.T) (*rsa.PrivateKey, string) {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	der, _ := x509.MarshalPKCS8PrivateKey(key)
	return key, string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}))
}

func verifyAssertion(t *testing.T, pub *rsa.PublicKey, assertion string) map[string]any {
	t.Helper()
	parts := strings.Split(assertion, ".")
	if len(parts) != 3 {
		t.Fatalf("assertion has %d segments", len(parts))
	}
	digest := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	sig, _ := base64.RawURLEncoding.DecodeString(parts[2])
	if err := rsa.VerifyPKCS1v15(pub, crypto.SHA256, digest[:], sig); err != nil {
		t.Fatalf("assertion signature invalid: %v", err)
	}
	payload, _ := base64.RawURLEncoding.DecodeString(parts[1])
	var claims map[string]any
	_ = json.Unmarshal(payload, &claims)
	return claims
}

func server(t *testing.T, key *rsa.PrivateKey) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		if r.Form.Get("grant_type") != grantJWTBearer {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		claims := verifyAssertion(t, &key.PublicKey, r.Form.Get("assertion"))
		if claims["iss"] != "openmap@bank-prod.iam.gserviceaccount.com" || claims["scope"] != "cloud-platform.read-only" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		_, _ = w.Write([]byte(`{"access_token":"ya29.test","expires_in":3599,"token_type":"Bearer"}`))
	})
	authed := func(body string) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			if r.Header.Get("Authorization") != "Bearer ya29.test" {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(body))
		}
	}
	mux.HandleFunc("/compute/v1/projects/bank-prod/aggregated/instances", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("pageToken") == "" {
			authed(`{"items":{"zones/me-central2-a":{"instances":[{"id":"7231","name":"app-ryd-01","zone":"https://compute.googleapis.com/compute/v1/projects/bank-prod/zones/me-central2-a","machineType":".../machineTypes/n2-standard-4","status":"RUNNING","cpuPlatform":"Intel Cascade Lake","labels":{"tier":"app"},"networkInterfaces":[{"network":"https://compute.googleapis.com/compute/v1/projects/bank-prod/global/networks/prod-vpc","subnetwork":"https://compute.googleapis.com/compute/v1/projects/bank-prod/regions/me-central2/subnetworks/app-subnet","networkIP":"10.60.1.11","accessConfigs":[{"natIP":"34.166.1.20","type":"ONE_TO_ONE_NAT"}]}],"disks":[{"boot":true,"diskSizeGb":"50","licenses":["https://www.googleapis.com/compute/v1/projects/debian-cloud/global/licenses/debian-12-bookworm"]}],"creationTimestamp":"2026-01-10T08:00:00.000-08:00"}]},"zones/me-central2-b":{"warning":{"code":"NO_RESULTS_ON_PAGE"}}},"nextPageToken":"p2"}`)(w, r)
			return
		}
		authed(`{"items":{"zones/me-central2-b":{"instances":[{"id":"7232","name":"app-ryd-02","zone":".../zones/me-central2-b","machineType":".../machineTypes/n2-standard-4","status":"TERMINATED","networkInterfaces":[{"network":"https://compute.googleapis.com/compute/v1/projects/bank-prod/global/networks/prod-vpc","subnetwork":"https://compute.googleapis.com/compute/v1/projects/bank-prod/regions/me-central2/subnetworks/app-subnet","networkIP":"10.60.1.12"}],"disks":[{"boot":true,"licenses":["https://www.googleapis.com/compute/v1/projects/windows-cloud/global/licenses/windows-server-2022-dc"]}]}]}}}`)(w, r)
	})
	mux.HandleFunc("/compute/v1/projects/bank-prod/global/networks", authed(`{"items":[{"id":"9001","name":"prod-vpc","selfLink":"https://compute.googleapis.com/compute/v1/projects/bank-prod/global/networks/prod-vpc"}]}`))
	mux.HandleFunc("/compute/v1/projects/bank-prod/aggregated/subnetworks", authed(`{"items":{"regions/me-central2":{"subnetworks":[{"id":"9101","name":"app-subnet","region":".../regions/me-central2","network":"https://compute.googleapis.com/compute/v1/projects/bank-prod/global/networks/prod-vpc","ipCidrRange":"10.60.1.0/24","selfLink":"https://compute.googleapis.com/compute/v1/projects/bank-prod/regions/me-central2/subnetworks/app-subnet"}]}}}`))
	mux.HandleFunc("/compute/v1/projects/bank-prod/aggregated/forwardingRules", authed(`{"items":{"regions/me-central2":{"forwardingRules":[{"id":"9201","name":"app-ilb","region":".../regions/me-central2","IPAddress":"10.60.1.250","IPProtocol":"TCP","portRange":"443-443","loadBalancingScheme":"INTERNAL","backendService":".../backendServices/app-bes"}]}}}`))
	mux.HandleFunc("/sql/v1beta4/projects/bank-prod/instances", authed(`{"items":[{"name":"ledger-pg","databaseVersion":"POSTGRES_16","region":"me-central2","state":"RUNNABLE","settings":{"tier":"db-custom-4-16384","availabilityType":"REGIONAL"},"ipAddresses":[{"ipAddress":"10.60.9.5","type":"PRIVATE"}],"connectionName":"bank-prod:me-central2:ledger-pg"}]}`))
	mux.HandleFunc("/v1/projects/bank-prod/locations/-/clusters", authed(`{"clusters":[{"id":"c1","name":"payments-gke","location":"me-central2","status":"RUNNING","currentMasterVersion":"1.32.4-gke.1","currentNodeCount":6,"endpoint":"10.60.8.2","network":"prod-vpc","subnetwork":"app-subnet"}]}`))
	return httptest.NewServer(mux)
}

func TestWalkAndEmit(t *testing.T) {
	key, pemKey := testKey(t)
	srv := server(t, key)
	defer srv.Close()
	cred := &contract.Credential{Type: credType, Fields: map[string]string{credEmail: "openmap@bank-prod.iam.gserviceaccount.com", credPrivateKey: pemKey}}
	options := map[string]any{optionTokenURL: srv.URL + "/token", optionScope: "cloud-platform.read-only", optionCompute: srv.URL, optionSQLAdmin: srv.URL, optionContainer: srv.URL}
	obs, err := Collector{}.Collect(context.Background(), contract.Target{Kind: "account", Value: "bank-prod"}, cred, options)
	if err != nil {
		t.Fatal(err)
	}
	types := map[string]int{}
	byName := map[string]contract.ObservedCi{}
	for _, ci := range obs.Cis {
		types[ci.Type]++
		byName[ci.Name] = ci
	}
	if types[typeAccount] != 1 || types[typeVM] != 2 || types[typeSubnet] != 1 || types[typeOS] != 2 || types[typeLB] != 1 || types[typeDBClust] != 1 || types[typeResource] != 2 {
		t.Fatalf("unexpected CI mix: %+v", types)
	}
	// 2 private VM addresses + 1 public + 1 ILB VIP + 1 SQL private = 5
	if types[typeIP] != 5 {
		t.Fatalf("expected 5 ip addresses, got %d", types[typeIP])
	}
	vm := byName["app-ryd-01"]
	if vm.Identity["fqdn"] != "app-ryd-01.me-central2-a.c.bank-prod.internal" || vm.Attributes["health"] != "healthy" || vm.Attributes["machineType"] != "n2-standard-4" {
		t.Fatalf("vm wrong: %+v", vm)
	}
	if byName["app-ryd-02"].Attributes["health"] != "down" || byName["windows-server-2022-dc"].Identity["family"] != "windows" {
		t.Fatalf("second vm or its os wrong")
	}
	sub := byName["prod-vpc/app-subnet"]
	if sub.Identity["cidr"] != "10.60.1.0/24" || sub.Identity["vrfRef"] != "prod-vpc" {
		t.Fatalf("subnet wrong: %+v", sub)
	}
	if byName["ledger-pg"].Attributes["engine"] != "postgres" || byName["ledger-pg"].Attributes["version"] != "16" || byName["app-ilb"].Attributes["scheme"] != "INTERNAL" || byName["payments-gke"].Attributes["nodeCount"] != 6 {
		t.Fatalf("managed services wrong")
	}
	rels := map[string]int{}
	for _, r := range obs.Relationships {
		rels[r.Type]++
	}
	if rels[relInSubnet] != 2 || rels[relInstalled] != 2 || rels[relRunsOn] != 1 || rels[relMemberOf] < 6 {
		t.Fatalf("relationship mix wrong: %+v", rels)
	}
	if len(obs.Evidence) < 7 {
		t.Fatalf("expected every API body as evidence, got %d", len(obs.Evidence))
	}
}

func TestBadKeyAndMissingOptions(t *testing.T) {
	cred := &contract.Credential{Type: credType, Fields: map[string]string{credEmail: "x@y", credPrivateKey: "not a key"}}
	_, err := Collector{}.Collect(context.Background(), contract.Target{Kind: "account", Value: "p"}, cred, map[string]any{optionTokenURL: "http://unused.invalid", optionScope: "s", optionCompute: "http://unused.invalid", optionSQLAdmin: "http://unused.invalid", optionContainer: "http://unused.invalid"})
	if err == nil || !strings.Contains(err.Error(), contract.ErrAuthFailed) {
		t.Fatalf("expected auth_failed for a bad key, got %v", err)
	}
	if _, err := (Collector{}).Collect(context.Background(), contract.Target{Kind: "account", Value: "p"}, cred, map[string]any{}); err == nil || !strings.Contains(err.Error(), optionTokenURL) {
		t.Fatalf("expected the missing option to be named, got %v", err)
	}
	if _, err := SignedJWT("a@b", "garbage", "s", "aud", time.Now()); err == nil {
		t.Fatal("garbage key must fail")
	}
}
