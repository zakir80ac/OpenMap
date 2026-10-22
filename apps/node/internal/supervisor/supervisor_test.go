// T-016 REQ-DISC-028
package supervisor

import (
	"context"
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/openmap/openmap/apps/node/internal/contract"
)

// fakeCollector writes a tiny script that echoes a result; on Windows a .cmd, elsewhere a shell script.
func fakeCollector(t *testing.T, dir, id, stdout string, exitCode int) {
	t.Helper()
	var path, body string
	if runtime.GOOS == "windows" {
		path = filepath.Join(dir, id+".exe.cmd")
		body = "@echo off\r\necho " + strings.ReplaceAll(stdout, "\"", "\"\"") + "\r\nexit /b " + itoa(exitCode) + "\r\n"
	} else {
		path = filepath.Join(dir, id)
		body = "#!/bin/sh\nprintf '%s' '" + stdout + "'\nexit " + itoa(exitCode) + "\n"
	}
	if err := os.WriteFile(path, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
}

func itoa(n int) string { return strings.TrimSpace(strings.Replace(string(rune('0'+n)), "", "", 0)) }

func TestValidateRejectsBadShapes(t *testing.T) {
	job := contract.Job{CollectorID: "snmp"}
	bad := contract.Result{Status: "weird", CollectorID: "other", Cis: []contract.ObservedCi{{Type: "", Name: "", Identity: nil}}}
	if problems := validate(bad, job); len(problems) != 3 {
		t.Fatalf("expected 3 problems, got %d: %v", len(problems), problems)
	}
	good := contract.Result{Status: contract.StatusSuccess, CollectorID: "snmp", Cis: []contract.ObservedCi{{Type: "host", Name: "h", Identity: map[string]string{"serialNumber": "x"}}}}
	if problems := validate(good, job); len(problems) != 0 {
		t.Fatalf("expected no problems, got %v", problems)
	}
}

func TestStoreEvidenceIsContentAddressed(t *testing.T) {
	dir := t.TempDir()
	s := New(dir, dir, slog.New(slog.NewTextHandler(os.Stderr, nil)))
	d1, err := s.StoreEvidence([]byte("walk"))
	if err != nil {
		t.Fatal(err)
	}
	d2, err := s.StoreEvidence([]byte("walk"))
	if err != nil {
		t.Fatal(err)
	}
	if d1 != d2 || len(d1) != 64 {
		t.Fatalf("digest mismatch or wrong length: %s %s", d1, d2)
	}
	if _, err := os.Stat(filepath.Join(dir, evidenceSubdir, d1[:2], d1)); err != nil {
		t.Fatal("evidence file missing")
	}
}

func TestRunTimesOutAndReportsFailure(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell script collectors are exercised on unix runners")
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "slow")
	if err := os.WriteFile(path, []byte("#!/bin/sh\nsleep 5\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	s := New(dir, dir, slog.New(slog.NewTextHandler(os.Stderr, nil)))
	job := contract.Job{JobID: "j", CollectorID: "slow", TimeoutMs: 100}
	res := s.Run(context.Background(), job, nil, "r")
	if res.Status != contract.StatusFailed || len(res.Errors) != 1 || res.Errors[0].Code != contract.ErrTimeout {
		t.Fatalf("expected timeout failure, got %+v", res)
	}
}

func TestRunParsesCollectorOutput(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell script collectors are exercised on unix runners")
	}
	dir := t.TempDir()
	out, _ := json.Marshal(contract.Result{Status: contract.StatusSuccess, CollectorID: "snmp", Cis: []contract.ObservedCi{{Type: "network_device", Name: "sw1", Identity: map[string]string{"serialNumber": "A"}, Attributes: map[string]any{}, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: time.Now().UTC()}}})
	fakeCollector(t, dir, "snmp", string(out), 0)
	s := New(dir, dir, slog.New(slog.NewTextHandler(os.Stderr, nil)))
	res := s.Run(context.Background(), contract.Job{JobID: "j", CollectorID: "snmp", TimeoutMs: 5000}, nil, "run-1")
	if res.Status != contract.StatusSuccess || len(res.Cis) != 1 || res.RunID != "run-1" {
		t.Fatalf("unexpected result %+v", res)
	}
}
