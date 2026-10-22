// REQ-DISC-001 — shared collector runtime: reads the invocation from stdin, runs the family's
// implementation with the job's concurrency and rate limit, and writes one Result to stdout.
// `--manifest` prints the manifest and exits, which is how the Node discovers installed collectors.
package collector

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
	"time"

	"golang.org/x/time/rate"

	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

// Implementation is what each family provides: one target in, observations out.
type Implementation interface {
	Manifest() contract.Manifest
	// Collect inspects one target. Errors are reported per target; a nil error with no CIs is valid.
	Collect(ctx context.Context, target contract.Target, cred *contract.Credential, options map[string]any) (Observation, error)
}

type Observation struct {
	Cis           []contract.ObservedCi
	Relationships []contract.ObservedRelationship
	// Raw evidence bytes; the runtime digests them and the Node stores them.
	Evidence []RawEvidence
}

type RawEvidence struct {
	Kind string
	Data []byte
}

// TargetError carries a contract error code so the result tells the scheduler whether to retry.
type TargetError struct {
	Code      string
	Message   string
	Retryable bool
}

func (e *TargetError) Error() string { return e.Code + ": " + e.Message }

func Errorf(code string, retryable bool, format string, args ...any) error {
	return &TargetError{Code: code, Message: fmt.Sprintf(format, args...), Retryable: retryable}
}

// StoreEvidence writes raw evidence bytes under <dir>/<kind>/<digest[:2]>/<digest>, content-addressed
// so identical captures are stored once. The Node's evidence API serves them back by digest.
func StoreEvidence(dir, kind, digest string, data []byte) error {
	sub := filepath.Join(dir, kind, digest[:2])
	if err := os.MkdirAll(sub, 0o700); err != nil {
		return err
	}
	path := filepath.Join(sub, digest)
	if _, err := os.Stat(path); err == nil {
		return nil
	}
	return os.WriteFile(path, data, 0o600)
}

// Main is the entry point every collector binary calls from its main().
func Main(impl Implementation) {
	if len(os.Args) > 1 && os.Args[1] == "--manifest" {
		enc := json.NewEncoder(os.Stdout)
		if err := enc.Encode(impl.Manifest()); err != nil {
			os.Exit(1)
		}
		return
	}
	code := Run(context.Background(), impl, os.Stdin, os.Stdout)
	os.Exit(code)
}

// Run executes an invocation read from `in` and writes the result to `out`. Exit code 0 on success,
// 1 when the result is partial or failed (the Node still reads the body), 2 on an unusable invocation.
func Run(ctx context.Context, impl Implementation, in io.Reader, out io.Writer) int {
	var inv contract.Invocation
	if err := json.NewDecoder(in).Decode(&inv); err != nil {
		fmt.Fprintln(os.Stderr, "invalid invocation:", err)
		return 2
	}
	result := Execute(ctx, impl, inv)
	if err := json.NewEncoder(out).Encode(result); err != nil {
		return 2
	}
	if result.Status == contract.StatusSuccess {
		return 0
	}
	return 1
}

// Execute runs every target with the job's concurrency and rate limit and assembles the result.
func Execute(ctx context.Context, impl Implementation, inv contract.Invocation) contract.Result {
	job := inv.Job
	started := time.Now().UTC()
	m := impl.Manifest()
	result := contract.Result{
		JobID: job.JobID, RunID: inv.RunID, TenantID: job.TenantID, CollectorID: m.ID, NodeID: job.NodeID, StartedAt: started,
		Cis: []contract.ObservedCi{}, Relationships: []contract.ObservedRelationship{}, Evidence: []contract.Evidence{}, Errors: []contract.CollectorError{},
		ContractVersion: contract.Version,
	}
	concurrency := job.RateLimit.Concurrency
	if concurrency < 1 {
		concurrency = 1
	}
	limiter := rate.NewLimiter(rate.Inf, 1)
	if job.RateLimit.RequestsPerSecond > 0 {
		limiter = rate.NewLimiter(rate.Limit(job.RateLimit.RequestsPerSecond), concurrency)
	}
	timeout := time.Duration(job.TimeoutMs) * time.Millisecond
	if timeout <= 0 {
		timeout = time.Hour
	}
	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	var mu sync.Mutex
	var wg sync.WaitGroup
	sem := make(chan struct{}, concurrency)
	reached := 0
	for _, target := range job.Targets {
		target := target
		wg.Add(1)
		sem <- struct{}{}
		go func() {
			defer wg.Done()
			defer func() { <-sem }()
			if err := limiter.Wait(runCtx); err != nil {
				mu.Lock()
				result.Errors = append(result.Errors, contract.CollectorError{Target: &target, Code: contract.ErrTimeout, Message: "job timeout before target started", Retryable: true})
				mu.Unlock()
				return
			}
			obs, err := impl.Collect(runCtx, target, inv.Credential, job.Options)
			mu.Lock()
			defer mu.Unlock()
			if err != nil {
				code, msg, retry := contract.ErrInternal, err.Error(), false
				if te, ok := err.(*TargetError); ok {
					code, msg, retry = te.Code, te.Message, te.Retryable
				}
				result.Errors = append(result.Errors, contract.CollectorError{Target: &target, Code: code, Message: msg, Retryable: retry})
				return
			}
			reached++
			result.Cis = append(result.Cis, obs.Cis...)
			result.Relationships = append(result.Relationships, obs.Relationships...)
			for _, ev := range obs.Evidence {
				sum := sha256.Sum256(ev.Data)
				digest := hex.EncodeToString(sum[:])
				if inv.EvidenceDir != "" {
					if err := StoreEvidence(inv.EvidenceDir, ev.Kind, digest, ev.Data); err != nil {
						result.Errors = append(result.Errors, contract.CollectorError{Target: &target, Code: contract.ErrInternal, Message: "evidence store: " + err.Error(), Retryable: false})
					}
				}
				result.Evidence = append(result.Evidence, contract.Evidence{Kind: ev.Kind, Target: target, Digest: digest, SizeBytes: len(ev.Data), CapturedAt: time.Now().UTC()})
			}
		}()
	}
	wg.Wait()
	result.FinishedAt = time.Now().UTC()
	result.Metrics = contract.Metrics{TargetsAttempted: len(job.Targets), TargetsReached: reached, CisEmitted: len(result.Cis), RelationshipsEmitted: len(result.Relationships), DurationMs: int(result.FinishedAt.Sub(started).Milliseconds())}
	switch {
	case reached == len(job.Targets) && len(result.Errors) == 0:
		result.Status = contract.StatusSuccess
	case reached == 0:
		result.Status = contract.StatusFailed
	default:
		result.Status = contract.StatusPartial
	}
	return result
}
