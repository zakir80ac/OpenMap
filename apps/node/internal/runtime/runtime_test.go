// T-017 REQ-DISC-028
package runtime

import (
	"context"
	"log/slog"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/openmap/openmap/apps/node/internal/contract"
	"github.com/openmap/openmap/apps/node/internal/transport"
)

type fakeScheduler struct {
	mu        sync.Mutex
	pulls     int
	results   []contract.Result
	heartbeat int
	jobs      []contract.Job
}

func (f *fakeScheduler) Heartbeat(context.Context, transport.Heartbeat) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.heartbeat++
	return nil
}

func (f *fakeScheduler) Pull(_ context.Context, req transport.PullRequest) ([]contract.Job, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.pulls++
	if len(f.jobs) == 0 {
		return nil, nil
	}
	n := min(req.Capacity, len(f.jobs))
	out := f.jobs[:n]
	f.jobs = f.jobs[n:]
	return out, nil
}

func (f *fakeScheduler) PostResult(_ context.Context, r contract.Result) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.results = append(f.results, r)
	return nil
}

func (f *fakeScheduler) ResolveCredential(_ context.Context, ref, _ string) (contract.Credential, error) {
	return contract.Credential{Type: "snmp_v3", Fields: map[string]string{"ref": ref}}, nil
}

type fakeRunner struct{ seenCred bool }

func (r *fakeRunner) Manifests(context.Context) ([]contract.Manifest, error) {
	return []contract.Manifest{{ID: "snmp", ContractVersion: contract.Version}}, nil
}

func (r *fakeRunner) Run(_ context.Context, job contract.Job, cred *contract.Credential, runID string) contract.Result {
	r.seenCred = cred != nil
	time.Sleep(20 * time.Millisecond)
	return contract.Result{JobID: job.JobID, RunID: runID, Status: contract.StatusSuccess}
}

func TestNodePullsRunsAndPostsWithinCapacity(t *testing.T) {
	ref := "openmap/creds/snmp"
	sched := &fakeScheduler{jobs: []contract.Job{{JobID: "a", CollectorID: "snmp", CredentialRef: &ref}, {JobID: "b", CollectorID: "snmp"}, {JobID: "c", CollectorID: "snmp"}}}
	runner := &fakeRunner{}
	node := New(Options{NodeID: "n1", SiteCode: "RYD", MaxConcurrentJobs: 2, PullInterval: 10 * time.Millisecond, HeartbeatInterval: 50 * time.Millisecond}, sched, runner, slog.New(slog.NewTextHandler(os.Stderr, nil)))
	ctx, cancel := context.WithTimeout(context.Background(), 400*time.Millisecond)
	defer cancel()
	if err := node.Run(ctx); err != nil {
		t.Fatal(err)
	}
	sched.mu.Lock()
	defer sched.mu.Unlock()
	if len(sched.results) != 3 {
		t.Fatalf("expected 3 results, got %d", len(sched.results))
	}
	if sched.heartbeat < 1 {
		t.Fatal("expected at least one heartbeat")
	}
	for _, r := range sched.results {
		if r.RunID == "" || r.Status != contract.StatusSuccess {
			t.Fatalf("bad result %+v", r)
		}
	}
}

func TestRunIDsAreUUIDv4(t *testing.T) {
	id := newRunID()
	if len(id) != 36 || id[14] != '4' {
		t.Fatalf("not a v4 uuid: %s", id)
	}
}
