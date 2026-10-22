// T-019 REQ-DISC-001 — shared runtime: concurrency, per-target errors and status rollup.
package collector

import (
	"context"
	"testing"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

type echo struct{}

func (echo) Manifest() contract.Manifest {
	return contract.Manifest{ID: "echo", Family: "snmp", Version: "0", Language: "go", TargetKinds: []string{"host"}, ContractVersion: contract.Version}
}

func (echo) Collect(_ context.Context, target contract.Target, _ *contract.Credential, _ map[string]any) (Observation, error) {
	if target.Value == "bad" {
		return Observation{}, Errorf(contract.ErrAuthFailed, false, "nope")
	}
	return Observation{Cis: []contract.ObservedCi{{Type: "host", Name: target.Value, Identity: map[string]string{"fqdn": target.Value}, ObservedAt: time.Now()}}, Evidence: []RawEvidence{{Kind: "cli_output", Data: []byte(target.Value)}}}, nil
}

func TestExecuteRollsUpStatus(t *testing.T) {
	job := contract.Job{JobID: "j", TenantID: "t", NodeID: "n", Targets: []contract.Target{{Kind: "host", Value: "a"}, {Kind: "host", Value: "bad"}, {Kind: "host", Value: "c"}}, RateLimit: contract.RateLimit{Concurrency: 2, RequestsPerSecond: 0}, TimeoutMs: 5000}
	res := Execute(context.Background(), echo{}, contract.Invocation{Job: job, RunID: "r"})
	if res.Status != contract.StatusPartial || res.Metrics.TargetsReached != 2 || len(res.Errors) != 1 || res.Errors[0].Code != contract.ErrAuthFailed {
		t.Fatalf("unexpected result %+v", res)
	}
	if len(res.Cis) != 2 || len(res.Evidence) != 2 || len(res.Evidence[0].Digest) != 64 {
		t.Fatalf("observations not merged: %+v", res)
	}
	if res.CollectorID != "echo" || res.RunID != "r" || res.ContractVersion != contract.Version {
		t.Fatalf("result header wrong: %+v", res)
	}
}

func TestExecuteAllFailedIsFailed(t *testing.T) {
	job := contract.Job{Targets: []contract.Target{{Kind: "host", Value: "bad"}}, RateLimit: contract.RateLimit{Concurrency: 1}}
	res := Execute(context.Background(), echo{}, contract.Invocation{Job: job})
	if res.Status != contract.StatusFailed {
		t.Fatalf("expected failed, got %s", res.Status)
	}
}
