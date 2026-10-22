// REQ-DISC-028 — Node runtime loop: heartbeat, pull jobs up to capacity, resolve credentials, run
// collectors through the supervisor, post results, back off on scheduler errors. Context cancels everything.
package runtime

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"log/slog"
	"sync"
	"time"

	"github.com/openmap/openmap/apps/node/internal/contract"
	"github.com/openmap/openmap/apps/node/internal/transport"
)

// Version is stamped at build time with -ldflags "-X .../runtime.Version=…".
var Version = "dev"

type Runner interface {
	Run(ctx context.Context, job contract.Job, cred *contract.Credential, runID string) contract.Result
	Manifests(ctx context.Context) ([]contract.Manifest, error)
}

type Scheduler interface {
	Heartbeat(ctx context.Context, hb transport.Heartbeat) error
	Pull(ctx context.Context, req transport.PullRequest) ([]contract.Job, error)
	PostResult(ctx context.Context, result contract.Result) error
	ResolveCredential(ctx context.Context, ref, jobID string) (contract.Credential, error)
}

type Options struct {
	NodeID            string
	SiteCode          string
	MaxConcurrentJobs int
	PullInterval      time.Duration
	HeartbeatInterval time.Duration
	CertExpiresAt     time.Time
}

type Node struct {
	opts   Options
	sched  Scheduler
	runner Runner
	log    *slog.Logger

	mu       sync.Mutex
	active   int
	manifest []string
}

func New(opts Options, sched Scheduler, runner Runner, log *slog.Logger) *Node {
	return &Node{opts: opts, sched: sched, runner: runner, log: log}
}

func newRunID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return hex.EncodeToString([]byte(time.Now().UTC().Format(time.RFC3339Nano)))
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	h := hex.EncodeToString(b[:])
	return h[:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
}

// Run blocks until ctx is cancelled. It never returns an error for transient scheduler failures;
// those are logged and retried on the next tick with exponential backoff capped at the heartbeat interval.
func (n *Node) Run(ctx context.Context) error {
	manifests, err := n.runner.Manifests(ctx)
	if err != nil {
		return err
	}
	for _, m := range manifests {
		n.manifest = append(n.manifest, m.ID)
	}
	n.log.Info("node starting", "node", n.opts.NodeID, "site", n.opts.SiteCode, "collectors", n.manifest, "version", Version)

	var wg sync.WaitGroup
	heartbeat := time.NewTicker(n.opts.HeartbeatInterval)
	defer heartbeat.Stop()
	pull := time.NewTicker(n.opts.PullInterval)
	defer pull.Stop()
	backoff := n.opts.PullInterval

	n.sendHeartbeat(ctx)
	for {
		select {
		case <-ctx.Done():
			wg.Wait()
			return nil
		case <-heartbeat.C:
			n.sendHeartbeat(ctx)
		case <-pull.C:
			capacity := n.capacity()
			if capacity == 0 {
				continue
			}
			jobs, err := n.sched.Pull(ctx, transport.PullRequest{Capacity: capacity, Collectors: n.manifest})
			if err != nil {
				n.log.Warn("pull failed", "err", err)
				backoff = min(backoff*2, n.opts.HeartbeatInterval)
				pull.Reset(backoff)
				continue
			}
			if backoff != n.opts.PullInterval {
				backoff = n.opts.PullInterval
				pull.Reset(backoff)
			}
			for _, job := range jobs {
				n.acquire()
				wg.Add(1)
				go func(job contract.Job) {
					defer wg.Done()
					defer n.release()
					n.execute(ctx, job)
				}(job)
			}
		}
	}
}

func (n *Node) execute(ctx context.Context, job contract.Job) {
	runID := newRunID()
	var cred *contract.Credential
	if job.CredentialRef != nil && *job.CredentialRef != "" {
		c, err := n.sched.ResolveCredential(ctx, *job.CredentialRef, job.JobID)
		if err != nil {
			n.log.Error("credential resolution failed", "job", job.JobID, "err", err)
			result := contract.Result{JobID: job.JobID, RunID: runID, TenantID: job.TenantID, CollectorID: job.CollectorID, NodeID: job.NodeID,
				Status: contract.StatusFailed, StartedAt: time.Now().UTC(), FinishedAt: time.Now().UTC(),
				Cis: []contract.ObservedCi{}, Relationships: []contract.ObservedRelationship{}, Evidence: []contract.Evidence{},
				Errors: []contract.CollectorError{{Code: contract.ErrAuthFailed, Message: "credential could not be resolved: " + err.Error(), Retryable: true}}, ContractVersion: contract.Version}
			n.post(ctx, result)
			return
		}
		cred = &c
	}
	result := n.runner.Run(ctx, job, cred, runID)
	n.post(ctx, result)
}

func (n *Node) post(ctx context.Context, result contract.Result) {
	delay := n.opts.PullInterval
	for attempt := 0; ; attempt++ {
		err := n.sched.PostResult(ctx, result)
		if err == nil {
			n.log.Info("result posted", "job", result.JobID, "status", result.Status, "cis", len(result.Cis), "errors", len(result.Errors))
			return
		}
		var httpErr *transport.HTTPError
		if errors.As(err, &httpErr) && !httpErr.Retryable() {
			n.log.Error("result rejected", "job", result.JobID, "err", err)
			return
		}
		n.log.Warn("result post failed, retrying", "job", result.JobID, "attempt", attempt, "err", err)
		select {
		case <-ctx.Done():
			return
		case <-time.After(delay):
			delay = min(delay*2, n.opts.HeartbeatInterval)
		}
	}
}

func (n *Node) sendHeartbeat(ctx context.Context) {
	hb := transport.Heartbeat{NodeID: n.opts.NodeID, SiteCode: n.opts.SiteCode, Version: Version, ActiveJobs: n.activeJobs(), MaxJobs: n.opts.MaxConcurrentJobs, Collectors: n.manifest, CertExpiresAt: n.opts.CertExpiresAt, SentAt: time.Now().UTC()}
	if err := n.sched.Heartbeat(ctx, hb); err != nil {
		n.log.Warn("heartbeat failed", "err", err)
	}
}

func (n *Node) capacity() int {
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.opts.MaxConcurrentJobs - n.active
}

func (n *Node) activeJobs() int {
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.active
}

func (n *Node) acquire() {
	n.mu.Lock()
	n.active++
	n.mu.Unlock()
}

func (n *Node) release() {
	n.mu.Lock()
	n.active--
	n.mu.Unlock()
}
