// REQ-QA-005 — shared test driver for vendor simulators: loads (or generates) the synthetic estate once,
// builds the real collector binary, runs every simulated run and fails the test on any mismatch.
package simtest

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"testing"

	"github.com/openmap/openmap/tools/simulator/internal/estate"
	"github.com/openmap/openmap/tools/simulator/internal/sim"
	"github.com/openmap/openmap/tools/simulator/internal/verify"
)

// EstateEnv overrides the estate directory the tests read.
const EstateEnv = "SIM_ESTATE"

var (
	once     sync.Once
	shared   *estate.Estate
	env      *sim.Env
	bins     *verify.Binaries
	setupErr error
)

func setup() {
	repo, err := verify.RepoRoot()
	if err != nil {
		setupErr = err
		return
	}
	dir := os.Getenv(EstateEnv)
	if dir == "" {
		dir = filepath.Join(repo, "packages", "testing", "fixtures", "synth-small")
	}
	if _, err := os.Stat(filepath.Join(dir, "estate-summary.json")); err != nil {
		gen := exec.Command("pnpm", "--filter", "@openmap/synth-estate", "exec", "tsx", "src/cli.ts", "generate", "--seed", "42", "--scale", "0.01", "--out", dir)
		gen.Dir = repo
		if out, err := gen.CombinedOutput(); err != nil {
			setupErr = &genError{err: err, out: string(out)}
			return
		}
	}
	shared, setupErr = estate.Load(dir)
	if setupErr != nil {
		return
	}
	env, setupErr = sim.NewEnv()
	if setupErr != nil {
		return
	}
	binDir, err := os.MkdirTemp("", "openmap-simtest-bin-")
	if err != nil {
		setupErr = err
		return
	}
	bins = verify.NewBinaries(repo, binDir)
}

type genError struct {
	err error
	out string
}

func (g *genError) Error() string {
	return "generate synthetic estate: " + g.err.Error() + ": " + g.out
}

// Estate returns the shared estate (for vendor-specific assertions).
func Estate(t *testing.T) *estate.Estate {
	t.Helper()
	once.Do(setup)
	if setupErr != nil {
		t.Fatal(setupErr)
	}
	return shared
}

// Run executes every run of v and requires each to pass. It returns the reports for further checks.
func Run(t *testing.T, v sim.Vendor) []verify.Report {
	t.Helper()
	e := Estate(t)
	reports, err := verify.RunVendor(context.Background(), e, env, bins, v)
	if err != nil {
		t.Fatal(err)
	}
	if len(reports) == 0 {
		t.Fatalf("%s planned no runs: the estate has nothing for this simulator", v.ID())
	}
	for _, r := range reports {
		if !r.Pass {
			body, _ := json.MarshalIndent(r, "", "  ")
			t.Errorf("%s/%s did not reproduce the estate:\n%s", r.Simulator, r.Run, body)
		} else {
			t.Logf("%s/%s: %d/%d CIs, %d/%d relationships, identity drift %d", r.Simulator, r.Run, r.MatchedCis, r.ExpectedCis, r.MatchedRels, r.ExpectedRels, r.IdentityDriftCount)
		}
	}
	return reports
}
