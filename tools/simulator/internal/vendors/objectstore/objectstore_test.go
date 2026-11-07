// T-394 REQ-QA-005 REQ-DISC-017 — the real object_storage collector signs every request with SigV4 and the
// simulated S3 endpoints verify each signature for real (TLS verified against the simulated-mode CA): the estate's
// AWS bucket and the seeded MinIO and Ceph RGW buckets are all reconstructed, and the same collector with a wrong
// secret is refused with SignatureDoesNotMatch (auth_failed).
package objectstore

import (
	"context"
	"os"
	"strings"
	"testing"

	"github.com/openmap/openmap/tools/simulator/internal/estate"
	"github.com/openmap/openmap/tools/simulator/internal/sim"
	"github.com/openmap/openmap/tools/simulator/internal/simtest"
	"github.com/openmap/openmap/tools/simulator/internal/verify"
)

func TestSimulatedObjectStores(t *testing.T) {
	reports := simtest.Run(t, Vendor{})
	if len(reports) != len(flavours(simtest.Estate(t))) {
		t.Fatalf("expected one run per flavour, got %d", len(reports))
	}
}

// wrongSecret is the vendor with every run signing with a secret the endpoints do not hold.
type wrongSecret struct{ Vendor }

func (w wrongSecret) Runs(e *estate.Estate, ep *sim.Endpoint, env *sim.Env) []sim.Run {
	runs := w.Vendor.Runs(e, ep, env)
	for i := range runs {
		runs[i].Credential = &sim.Credential{Type: "api_token", Fields: map[string]string{"accessKeyId": env.User, "secretAccessKey": env.Secret + "x"}}
	}
	return runs
}

func TestWrongSecretIsRefused(t *testing.T) {
	e := simtest.Estate(t)
	repo, err := verify.RepoRoot()
	if err != nil {
		t.Fatal(err)
	}
	env, err := sim.NewEnv()
	if err != nil {
		t.Fatal(err)
	}
	dir, err := os.MkdirTemp("", "openmap-simtest-s3-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(dir)
	reports, err := verify.RunVendor(context.Background(), e, env, verify.NewBinaries(repo, dir), wrongSecret{})
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range reports {
		if r.Pass || !strings.Contains(strings.Join(r.Errors, " "), "auth_failed") || !strings.Contains(strings.Join(r.Errors, " "), "SignatureDoesNotMatch") {
			t.Errorf("%s: a wrong secret must fail with SignatureDoesNotMatch, got %+v", r.Run, r.Errors)
		}
	}
}
