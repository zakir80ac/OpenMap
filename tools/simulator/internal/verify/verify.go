// REQ-QA-005 — the simulated-mode harness: builds a real collector binary from apps/collectors, starts the
// vendor simulator, pipes the collector a contract Invocation (exactly what the Discovery Node sends), and
// compares the Result with what the estate says the collector must find.
package verify

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"

	"github.com/openmap/openmap/tools/simulator/internal/estate"
	"github.com/openmap/openmap/tools/simulator/internal/sim"
)

const (
	defaultTimeout = 2 * time.Minute
	concurrency    = 4
	nodeID         = "simulator"
	uuidBytes      = 16
	// sampleLimit caps how many missing items a report lists.
	sampleLimit = 20
)

type ciRef struct {
	ID       string            `json:"id,omitempty"`
	Type     string            `json:"type,omitempty"`
	Identity map[string]string `json:"identity,omitempty"`
}

type observedCi struct {
	Type       string            `json:"type"`
	Identity   map[string]string `json:"identity"`
	Name       string            `json:"name"`
	Attributes map[string]any    `json:"attributes"`
}

type observedRel struct {
	Type string `json:"type"`
	From ciRef  `json:"from"`
	To   ciRef  `json:"to"`
}

type collectorError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// Result is the part of the collector contract Result the harness reads.
type Result struct {
	CollectorID     string           `json:"collectorId"`
	Status          string           `json:"status"`
	Cis             []observedCi     `json:"cis"`
	Relationships   []observedRel    `json:"relationships"`
	Errors          []collectorError `json:"errors"`
	ContractVersion string           `json:"contractVersion"`
}

type Report struct {
	Simulator     string          `json:"simulator"`
	Run           string          `json:"run"`
	Collector     string          `json:"collector"`
	Requirements  []string        `json:"requirements"`
	Provenance    string          `json:"provenance"`
	Status        string          `json:"status"`
	Pass          bool            `json:"pass"`
	ExpectedCis   int             `json:"expectedCis"`
	MatchedCis    int             `json:"matchedCis"`
	ExpectedRels  int             `json:"expectedRelationships"`
	MatchedRels   int             `json:"matchedRelationships"`
	EmittedCis    int             `json:"emittedCis"`
	EmittedRels   int             `json:"emittedRelationships"`
	EmittedByType map[string]int  `json:"emittedByType"`
	MissingCis    []sim.ExpectCI  `json:"missingCis,omitempty"`
	MissingRels   []sim.ExpectRel `json:"missingRelationships,omitempty"`
	// IdentityDrift lists matched CIs whose collector identity would not merge with the estate's CI.
	IdentityDriftCount int     `json:"identityDriftCount"`
	IdentityDrift      []Drift `json:"identityDrift,omitempty"`
	// AttributeMismatches are expected attribute values the collector did not reproduce; any fails the run.
	AttributeMismatchCount int        `json:"attributeMismatchCount"`
	AttributeMismatches    []Mismatch `json:"attributeMismatches,omitempty"`
	Errors                 []string   `json:"errors,omitempty"`
	Requests               int        `json:"requests"`
	RequestSample          []string   `json:"requestSample,omitempty"`
	DurationMs             int64      `json:"durationMs"`
}

// Binaries builds collector binaries on demand into dir and caches the paths.
type Binaries struct {
	Repo string
	Dir  string
	done map[string]string
}

func NewBinaries(repo, dir string) *Binaries {
	return &Binaries{Repo: repo, Dir: dir, done: map[string]string{}}
}

func (b *Binaries) Path(ctx context.Context, collector string) (string, error) {
	if p, ok := b.done[collector]; ok {
		return p, nil
	}
	name := collector
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	out := filepath.Join(b.Dir, name)
	cmd := exec.CommandContext(ctx, "go", "build", "-o", out, "./cmd/"+collector)
	cmd.Dir = filepath.Join(b.Repo, "apps", "collectors")
	if msg, err := cmd.CombinedOutput(); err != nil {
		return "", fmt.Errorf("go build %s: %w: %s", collector, err, msg)
	}
	b.done[collector] = out
	return out, nil
}

func uuid() string {
	b := make([]byte, uuidBytes)
	_, _ = rand.Read(b)
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	h := hex.EncodeToString(b)
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
}

type manifest struct {
	ContractVersion string `json:"contractVersion"`
}

// Invocation builds the stdin document for one run.
func Invocation(e *estate.Estate, collector, contractVersion string, run sim.Run) map[string]any {
	timeout := run.TimeoutMs
	if timeout == 0 {
		timeout = int(defaultTimeout.Milliseconds())
	}
	options := map[string]any{}
	for k, v := range run.Options {
		options[k] = v
	}
	ref := "simulated/" + collector
	job := map[string]any{
		"jobId": uuid(), "tenantId": e.TenantID, "collectorId": collector, "nodeId": nodeID,
		"targets": run.Targets, "credentialRef": ref, "credentialType": run.CredentialType,
		"timeoutMs": timeout, "rateLimit": map[string]any{"concurrency": concurrency, "requestsPerSecond": 0},
		"options": options, "scheduledAt": time.Now().UTC().Format(time.RFC3339Nano), "contractVersion": contractVersion,
	}
	if run.Credential == nil {
		job["credentialRef"] = nil
	}
	return map[string]any{"job": job, "credential": run.Credential, "runId": uuid()}
}

// Execute runs one collector invocation and returns the parsed result.
func Execute(ctx context.Context, bin string, inv map[string]any, timeout time.Duration) (*Result, []byte, error) {
	body, err := json.Marshal(inv)
	if err != nil {
		return nil, nil, err
	}
	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.CommandContext(runCtx, bin)
	cmd.Stdin = bytes.NewReader(body)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err = cmd.Run()
	if stdout.Len() == 0 {
		return nil, stderr.Bytes(), fmt.Errorf("collector produced no result: %v: %s", err, stderr.String())
	}
	var res Result
	if jerr := json.Unmarshal(stdout.Bytes(), &res); jerr != nil {
		return nil, stderr.Bytes(), fmt.Errorf("result is not JSON: %w", jerr)
	}
	return &res, stderr.Bytes(), nil
}

func contractVersion(ctx context.Context, bin string) (string, error) {
	out, err := exec.CommandContext(ctx, bin, "--manifest").Output()
	if err != nil {
		return "", err
	}
	var m manifest
	if err := json.Unmarshal(out, &m); err != nil {
		return "", err
	}
	return m.ContractVersion, nil
}

func ciKey(t, name string) string { return t + "\x00" + strings.ToLower(name) }

// Match is the outcome of comparing a result with an expectation.
type Match struct {
	MatchedCis    int
	MissingCis    []sim.ExpectCI
	MatchedRels   int
	MissingRels   []sim.ExpectRel
	ByType        map[string]int
	IdentityDrift []Drift
	// AttributeMismatches are expected attribute values the collector reported differently (or not at all).
	AttributeMismatches []Mismatch
}

// Mismatch is one expected attribute the emitted CI does not carry with the expected value.
type Mismatch struct {
	Type      string `json:"type"`
	Name      string `json:"name"`
	Attribute string `json:"attribute"`
	Want      any    `json:"want"`
	Got       any    `json:"got"`
}

func sameJSON(a, b any) bool {
	ja, errA := json.Marshal(a)
	jb, errB := json.Marshal(b)
	return errA == nil && errB == nil && string(ja) == string(jb)
}

// Drift is an emitted CI whose identity would not merge with the estate's identity for it.
type Drift struct {
	Type      string            `json:"type"`
	Name      string            `json:"name"`
	Estate    map[string]string `json:"estate"`
	Collector map[string]string `json:"collector"`
}

// aligned reports whether two identities would merge: they share at least one key and agree on every
// shared key.
func aligned(a, b map[string]string) bool {
	common := 0
	for k, v := range a {
		bv, ok := b[k]
		if !ok {
			continue
		}
		if !strings.EqualFold(bv, v) {
			return false
		}
		common++
	}
	return common > 0
}

func subset(want, have map[string]string) bool {
	if len(want) == 0 {
		return false
	}
	for k, v := range want {
		if !strings.EqualFold(have[k], v) {
			return false
		}
	}
	return true
}

type end struct {
	typ      string
	name     string
	identity map[string]string
}

func (e end) matches(t, name string, identity map[string]string, nameKnown bool) bool {
	if e.typ != t {
		return false
	}
	if e.identity != nil {
		return subset(e.identity, identity)
	}
	return nameKnown && strings.EqualFold(e.name, name)
}

// Compare checks a result against the run's expectation.
func Compare(res *Result, want sim.Expect) Match {
	m := Match{ByType: map[string]int{}}
	have := map[string][]observedCi{}
	names := map[string]string{}
	for _, c := range res.Cis {
		m.ByType[c.Type]++
		k := ciKey(c.Type, c.Name)
		have[k] = append(have[k], c)
		names[estate.Key(c.Type, c.Identity)] = c.Name
	}
	for _, w := range want.CIs {
		k := ciKey(w.Type, w.Name)
		list := have[k]
		if len(list) == 0 {
			m.MissingCis = append(m.MissingCis, w)
			continue
		}
		got := list[0]
		have[k] = list[1:]
		m.MatchedCis++
		for k, want := range w.Attributes {
			if !sameJSON(want, got.Attributes[k]) {
				m.AttributeMismatches = append(m.AttributeMismatches, Mismatch{Type: w.Type, Name: w.Name, Attribute: k, Want: want, Got: got.Attributes[k]})
			}
		}
		if w.Identity != nil && !aligned(w.Identity, got.Identity) {
			m.IdentityDrift = append(m.IdentityDrift, Drift{Type: w.Type, Name: w.Name, Estate: w.Identity, Collector: got.Identity})
		}
	}
	used := make([]bool, len(res.Relationships))
	for _, w := range want.Rels {
		from := end{typ: w.FromType, name: w.From, identity: w.FromIdentity}
		to := end{typ: w.ToType, name: w.To, identity: w.ToIdentity}
		found := false
		for i, r := range res.Relationships {
			if used[i] || r.Type != w.Type {
				continue
			}
			fn, fok := names[estate.Key(r.From.Type, r.From.Identity)]
			tn, tok := names[estate.Key(r.To.Type, r.To.Identity)]
			if from.matches(r.From.Type, fn, r.From.Identity, fok) && to.matches(r.To.Type, tn, r.To.Identity, tok) {
				used[i] = true
				found = true
				break
			}
		}
		if found {
			m.MatchedRels++
		} else {
			m.MissingRels = append(m.MissingRels, w)
		}
	}
	return m
}

// RunVendor starts one simulator, executes every run against it and reports each.
func RunVendor(ctx context.Context, e *estate.Estate, env *sim.Env, bins *Binaries, v sim.Vendor) ([]Report, error) {
	bin, err := bins.Path(ctx, v.Collector())
	if err != nil {
		return nil, err
	}
	cv, err := contractVersion(ctx, bin)
	if err != nil {
		return nil, fmt.Errorf("%s --manifest: %w", v.Collector(), err)
	}
	ep, err := v.Start(ctx, e, env)
	if err != nil {
		return nil, fmt.Errorf("start %s: %w", v.ID(), err)
	}
	defer func() { _ = ep.Close() }()
	var reports []Report
	for _, run := range v.Runs(e, ep, env) {
		reports = append(reports, runOne(ctx, e, env, bin, cv, v, ep, run))
	}
	return reports, nil
}

func runOne(ctx context.Context, e *estate.Estate, env *sim.Env, bin, cv string, v sim.Vendor, ep *sim.Endpoint, run sim.Run) Report {
	rep := Report{Simulator: v.ID(), Run: run.Name, Collector: v.Collector(), Requirements: v.Requirements(), Provenance: sim.Provenance,
		ExpectedCis: len(run.Expect.CIs), ExpectedRels: len(run.Expect.Rels)}
	started := time.Now()
	timeout := defaultTimeout
	if run.TimeoutMs > 0 {
		timeout = time.Duration(run.TimeoutMs)*time.Millisecond + defaultTimeout
	}
	driveCtx, stopDrive := context.WithCancel(ctx)
	driveErr := make(chan error, 1)
	if c, ok := v.(sim.Concurrent); ok {
		go func() { driveErr <- c.Drive(driveCtx, e, ep, run, env) }()
	} else {
		driveErr <- nil
	}
	res, stderr, err := Execute(ctx, bin, Invocation(e, v.Collector(), cv, run), timeout)
	stopDrive()
	if derr := <-driveErr; derr != nil && driveCtx.Err() == nil {
		rep.Errors = append(rep.Errors, "simulator drive: "+derr.Error())
	}
	rep.DurationMs = time.Since(started).Milliseconds()
	if log, ok := ep.State["log"].(*sim.RequestLog); ok {
		entries := log.Snapshot()
		rep.Requests = len(entries)
		if len(entries) > sampleLimit {
			entries = entries[:sampleLimit]
		}
		rep.RequestSample = entries
	}
	if err != nil {
		rep.Status = "error"
		rep.Errors = append(rep.Errors, err.Error())
		if len(stderr) > 0 {
			rep.Errors = append(rep.Errors, string(stderr))
		}
		return rep
	}
	rep.Status = res.Status
	for _, ce := range res.Errors {
		rep.Errors = append(rep.Errors, ce.Code+": "+ce.Message)
	}
	rep.EmittedCis, rep.EmittedRels = len(res.Cis), len(res.Relationships)
	m := Compare(res, run.Expect)
	missC, missR := m.MissingCis, m.MissingRels
	rep.MatchedCis, rep.MatchedRels, rep.EmittedByType = m.MatchedCis, m.MatchedRels, m.ByType
	rep.IdentityDriftCount = len(m.IdentityDrift)
	if len(m.IdentityDrift) > sampleLimit {
		m.IdentityDrift = m.IdentityDrift[:sampleLimit]
	}
	rep.IdentityDrift = m.IdentityDrift
	rep.AttributeMismatchCount = len(m.AttributeMismatches)
	if len(m.AttributeMismatches) > sampleLimit {
		m.AttributeMismatches = m.AttributeMismatches[:sampleLimit]
	}
	rep.AttributeMismatches = m.AttributeMismatches
	rep.Pass = res.Status == "success" && len(missC) == 0 && len(missR) == 0 && len(rep.Errors) == 0 && rep.ExpectedCis > 0 && rep.AttributeMismatchCount == 0
	if len(missC) > sampleLimit {
		missC = missC[:sampleLimit]
	}
	if len(missR) > sampleLimit {
		missR = missR[:sampleLimit]
	}
	rep.MissingCis, rep.MissingRels = missC, missR
	return rep
}

// Summary renders reports as a fixed-width table.
func Summary(reports []Report) string {
	sort.SliceStable(reports, func(i, j int) bool { return reports[i].Simulator < reports[j].Simulator })
	var b strings.Builder
	fmt.Fprintf(&b, "%-26s %-22s %-8s %-5s %13s %13s %6s %8s\n", "simulator", "run", "status", "pass", "CIs", "rels", "drift", "ms")
	for _, r := range reports {
		fmt.Fprintf(&b, "%-26s %-22s %-8s %-5v %6d/%-6d %6d/%-6d %6d %8d\n", r.Simulator, r.Run, r.Status, r.Pass, r.MatchedCis, r.ExpectedCis, r.MatchedRels, r.ExpectedRels, r.IdentityDriftCount, r.DurationMs)
	}
	return b.String()
}

// RepoRoot walks up from the working directory to the directory holding go.work.
func RepoRoot() (string, error) {
	dir, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.work")); err == nil {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", fmt.Errorf("go.work not found above the working directory")
		}
		dir = parent
	}
}
