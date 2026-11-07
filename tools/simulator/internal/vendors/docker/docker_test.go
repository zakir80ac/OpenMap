// T-384 REQ-QA-005 REQ-DISC-011 — the real docker_engine collector, over TLS verified against the simulated-mode
// CA and authenticated by a client certificate, inventories two seeded engines (classic and containerd image
// stores): the engine host and OS, containers, registries, compose and bridge subnets and container addresses.
package docker

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"net/http"
	"strings"
	"testing"

	"github.com/openmap/openmap/tools/simulator/internal/sim"
	"github.com/openmap/openmap/tools/simulator/internal/simtest"
)

func TestSimulatedDockerEngines(t *testing.T) {
	reports := simtest.Run(t, Vendor{})
	if len(reports) != len(engines(simtest.Estate(t))) || len(reports) < 2 {
		t.Fatalf("expected a classic-store and a containerd-store engine run, got %d", len(reports))
	}
}

// Like dockerd --tlsverify, an engine refuses a client that presents no client certificate.
func TestEngineRequiresClientCertificate(t *testing.T) {
	env, err := sim.NewEnv()
	if err != nil {
		t.Fatal(err)
	}
	ep, err := Vendor{}.Start(context.Background(), simtest.Estate(t), env)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = ep.Close() }()
	pool := x509.NewCertPool()
	pool.AppendCertsFromPEM([]byte(env.CA.PEM))
	client := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}}}
	for _, addr := range ep.Devices {
		res, err := client.Get("https://" + strings.TrimPrefix(addr, "tcp://") + "/_ping")
		if err == nil {
			res.Body.Close()
			t.Fatalf("%s answered without a client certificate", addr)
		}
	}
}
