// REQ-DISC-028 — collector supervisor: runs a collector binary per job as a subprocess with the
// invocation on stdin, enforces the job timeout, validates the result shape, stores evidence by
// digest and returns the result. Collectors are isolated processes so a crash never takes the Node down.
package supervisor

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"time"

	"github.com/openmap/openmap/apps/node/internal/contract"
)

const (
	manifestFlag   = "--manifest"
	evidenceSubdir = "raw"
	maxStderrBytes = 1 << 20
)

type Supervisor struct {
	collectorsDir string
	evidenceDir   string
	log           *slog.Logger
}

func New(collectorsDir, evidenceDir string, log *slog.Logger) *Supervisor {
	return &Supervisor{collectorsDir: collectorsDir, evidenceDir: evidenceDir, log: log}
}

func (s *Supervisor) binary(collectorID string) string {
	name := collectorID
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	return filepath.Join(s.collectorsDir, name)
}

// Manifests discovers installed collectors by asking each binary for its manifest.
func (s *Supervisor) Manifests(ctx context.Context) ([]contract.Manifest, error) {
	entries, err := os.ReadDir(s.collectorsDir)
	if err != nil {
		return nil, fmt.Errorf("collectors dir: %w", err)
	}
	var out []contract.Manifest
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		cmd := exec.CommandContext(ctx, filepath.Join(s.collectorsDir, e.Name()), manifestFlag)
		data, err := cmd.Output()
		if err != nil {
			s.log.Warn("collector manifest failed", "binary", e.Name(), "err", err)
			continue
		}
		var m contract.Manifest
		if err := json.Unmarshal(data, &m); err != nil {
			s.log.Warn("collector manifest invalid", "binary", e.Name(), "err", err)
			continue
		}
		if m.ContractVersion != contract.Version {
			s.log.Warn("collector contract version mismatch", "collector", m.ID, "have", m.ContractVersion, "want", contract.Version)
			continue
		}
		out = append(out, m)
	}
	return out, nil
}

// Run executes the collector for a job. The returned Result is always well-formed: a crash or timeout
// becomes a failed result with one internal or timeout error, so the scheduler always learns the outcome.
func (s *Supervisor) Run(ctx context.Context, job contract.Job, cred *contract.Credential, runID string) contract.Result {
	started := time.Now().UTC()
	result := contract.Result{
		JobID: job.JobID, RunID: runID, TenantID: job.TenantID, CollectorID: job.CollectorID, NodeID: job.NodeID,
		StartedAt: started, Cis: []contract.ObservedCi{}, Relationships: []contract.ObservedRelationship{},
		Evidence: []contract.Evidence{}, Errors: []contract.CollectorError{}, ContractVersion: contract.Version,
	}
	timeout := time.Duration(job.TimeoutMs) * time.Millisecond
	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	input, err := json.Marshal(contract.Invocation{Job: job, Credential: cred, RunID: runID, EvidenceDir: s.evidenceDir})
	if err != nil {
		return s.fail(result, started, contract.ErrInternal, "encode invocation: "+err.Error(), false)
	}
	cmd := exec.CommandContext(runCtx, s.binary(job.CollectorID))
	cmd.Stdin = bytes.NewReader(input)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &limitedWriter{buf: &stderr, max: maxStderrBytes}
	cmd.Env = minimalEnv()
	err = cmd.Run()
	if errors.Is(runCtx.Err(), context.DeadlineExceeded) {
		return s.fail(result, started, contract.ErrTimeout, fmt.Sprintf("collector exceeded %s", timeout), true)
	}
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) && stdout.Len() > 0 {
			// Non-zero exit with a result body: the collector reported partial or failed itself.
			s.log.Info("collector exited non-zero with a result", "collector", job.CollectorID, "code", exitErr.ExitCode())
		} else {
			return s.fail(result, started, contract.ErrInternal, "collector failed: "+err.Error()+" "+stderr.String(), true)
		}
	}
	var produced contract.Result
	if err := json.Unmarshal(stdout.Bytes(), &produced); err != nil {
		return s.fail(result, started, contract.ErrParse, "collector output is not a valid result: "+err.Error(), false)
	}
	if problems := validate(produced, job); len(problems) > 0 {
		return s.fail(result, started, contract.ErrParse, "collector result rejected: "+errors.Join(problems...).Error(), false)
	}
	produced.JobID, produced.RunID, produced.NodeID, produced.TenantID = job.JobID, runID, job.NodeID, job.TenantID
	produced.StartedAt = started
	produced.FinishedAt = time.Now().UTC()
	produced.Metrics.DurationMs = int(produced.FinishedAt.Sub(started).Milliseconds())
	produced.ContractVersion = contract.Version
	if produced.Cis == nil {
		produced.Cis = []contract.ObservedCi{}
	}
	if produced.Relationships == nil {
		produced.Relationships = []contract.ObservedRelationship{}
	}
	if produced.Evidence == nil {
		produced.Evidence = []contract.Evidence{}
	}
	if produced.Errors == nil {
		produced.Errors = []contract.CollectorError{}
	}
	return produced
}

func (s *Supervisor) fail(r contract.Result, started time.Time, code, message string, retryable bool) contract.Result {
	r.Status = contract.StatusFailed
	r.FinishedAt = time.Now().UTC()
	r.Metrics.DurationMs = int(r.FinishedAt.Sub(started).Milliseconds())
	r.Errors = append(r.Errors, contract.CollectorError{Code: code, Message: message, Retryable: retryable})
	return r
}

// StoreEvidence writes raw evidence bytes under their SHA-256 digest and returns the digest.
func (s *Supervisor) StoreEvidence(data []byte) (string, error) {
	sum := sha256.Sum256(data)
	digest := hex.EncodeToString(sum[:])
	dir := filepath.Join(s.evidenceDir, evidenceSubdir, digest[:2])
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	path := filepath.Join(dir, digest)
	if _, err := os.Stat(path); err == nil {
		return digest, nil
	}
	return digest, os.WriteFile(path, data, 0o600)
}

func validate(r contract.Result, job contract.Job) []error {
	var problems []error
	switch r.Status {
	case contract.StatusSuccess, contract.StatusPartial, contract.StatusFailed:
	default:
		problems = append(problems, fmt.Errorf("status %q is not success, partial or failed", r.Status))
	}
	if r.CollectorID != "" && r.CollectorID != job.CollectorID {
		problems = append(problems, fmt.Errorf("collectorId %q does not match job %q", r.CollectorID, job.CollectorID))
	}
	for i, ci := range r.Cis {
		if ci.Type == "" || ci.Name == "" || len(ci.Identity) == 0 {
			problems = append(problems, fmt.Errorf("ci[%d] needs type, name and at least one identity key", i))
		}
	}
	for i, rel := range r.Relationships {
		if rel.Type == "" || (rel.From.ID == "" && rel.From.Type == "") || (rel.To.ID == "" && rel.To.Type == "") {
			problems = append(problems, fmt.Errorf("relationship[%d] needs type and resolvable endpoints", i))
		}
	}
	for i, ev := range r.Evidence {
		if len(ev.Digest) != sha256.Size*2 {
			problems = append(problems, fmt.Errorf("evidence[%d] digest is not sha256 hex", i))
		}
	}
	return problems
}

// minimalEnv gives collectors only locale and path, never the Node's own secrets.
func minimalEnv() []string {
	var env []string
	for _, key := range []string{"PATH", "LANG", "LC_ALL", "TMPDIR", "TEMP", "TMP", "SystemRoot"} {
		if v, ok := os.LookupEnv(key); ok {
			env = append(env, key+"="+v)
		}
	}
	return env
}

type limitedWriter struct {
	buf *bytes.Buffer
	max int
}

func (w *limitedWriter) Write(p []byte) (int, error) {
	if w.buf.Len() >= w.max {
		return len(p), nil
	}
	room := w.max - w.buf.Len()
	if len(p) > room {
		p = p[:room]
	}
	w.buf.Write(p)
	return len(p), nil
}
