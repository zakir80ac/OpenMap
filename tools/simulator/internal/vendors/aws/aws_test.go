// T-420 REQ-QA-005 REQ-DISC-010 — the real cloud_aws collector, pointed at the simulated gateway with endpointUrl
// and TLS verified against the simulated-mode CA, signs every request with SigV4 (verified server-side), walks
// the estate region and an empty second region, and reconstructs the estate's AWS account and its VPC, EC2
// instance, RDS instance and load balancer with the subnets, VMs and addresses behind them. Unsigned and
// mis-signed requests are refused the way AWS refuses them.
package aws

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/openmap/openmap/tools/simulator/internal/sim"
	"github.com/openmap/openmap/tools/simulator/internal/simtest"
)

func TestSimulatedAWS(t *testing.T) {
	for _, r := range simtest.Run(t, Vendor{}) {
		for _, d := range r.IdentityDrift {
			t.Logf("identity drift %s %q: estate %v, collector %v", d.Type, d.Name, d.Estate, d.Collector)
		}
		t.Logf("%d signed requests, first %d: %v", r.Requests, len(r.RequestSample), r.RequestSample)
		if r.Requests == 0 {
			t.Fatal("no requests reached the simulator")
		}
	}
}

func TestSignatureEnforced(t *testing.T) {
	e := simtest.Estate(t)
	env, err := sim.NewEnv()
	if err != nil {
		t.Fatal(err)
	}
	ep, err := Vendor{}.Start(context.Background(), e, env)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = ep.Close() }()
	pool := x509.NewCertPool()
	pool.AppendCertsFromPEM([]byte(env.CA.PEM))
	client := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}}}
	for _, base := range ep.Devices {
		for name, auth := range map[string]string{
			"MissingAuthenticationToken": "",
			"SignatureDoesNotMatch":      "AWS4-HMAC-SHA256 Credential=" + accessKey(env) + "/" + time.Now().UTC().Format("20060102") + "/me-south-1/sts/aws4_request, SignedHeaders=host;x-amz-date, Signature=00",
			"InvalidClientTokenId":       "AWS4-HMAC-SHA256 Credential=AKIAOTHER/" + time.Now().UTC().Format("20060102") + "/me-south-1/sts/aws4_request, SignedHeaders=host;x-amz-date, Signature=00",
		} {
			req, _ := http.NewRequest(http.MethodGet, base+"/?Action=GetCallerIdentity&Version=2011-06-15", nil)
			req.Header.Set("X-Amz-Date", time.Now().UTC().Format(amzDateLayout))
			if auth != "" {
				req.Header.Set("Authorization", auth)
			}
			res, err := client.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			buf := make([]byte, 1024)
			n, _ := res.Body.Read(buf)
			_ = res.Body.Close()
			if res.StatusCode != http.StatusForbidden || !strings.Contains(string(buf[:n]), name) {
				t.Errorf("%s: got %d %s", name, res.StatusCode, buf[:n])
			}
		}
	}
}
