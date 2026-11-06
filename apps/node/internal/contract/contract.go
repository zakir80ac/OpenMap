// REQ-CORE-002 — Go view of the collector contract (packages/contracts/schemas/*.schema.json).
// Field names and JSON tags mirror the zod schemas exactly; the TypeScript side is the source of truth
// and the contract test loads the emitted JSON Schema to check these types stay in step.
package contract

import "time"

// Version is the collector contract version this binary speaks.
const Version = "0.5.0"

type Target struct {
	Kind  string `json:"kind"`
	Value string `json:"value"`
	Label string `json:"label,omitempty"`
}

type RateLimit struct {
	Concurrency       int     `json:"concurrency"`
	RequestsPerSecond float64 `json:"requestsPerSecond"`
}

type Job struct {
	JobID           string         `json:"jobId"`
	TenantID        string         `json:"tenantId"`
	CollectorID     string         `json:"collectorId"`
	NodeID          string         `json:"nodeId"`
	Targets         []Target       `json:"targets"`
	CredentialRef   *string        `json:"credentialRef"`
	CredentialType  string         `json:"credentialType"`
	TimeoutMs       int            `json:"timeoutMs"`
	RateLimit       RateLimit      `json:"rateLimit"`
	Options         map[string]any `json:"options"`
	ScheduledAt     time.Time      `json:"scheduledAt"`
	ContractVersion string         `json:"contractVersion"`
}

type ExternalID struct {
	Source string `json:"source"`
	ID     string `json:"id"`
}

type ObservedCi struct {
	Type        string            `json:"type"`
	Identity    map[string]string `json:"identity"`
	Name        string            `json:"name"`
	Attributes  map[string]any    `json:"attributes"`
	Tags        []string          `json:"tags"`
	ExternalIDs []ExternalID      `json:"externalIds"`
	ObservedAt  time.Time         `json:"observedAt"`
	// Components is the full part list when the collector sees parts (REQ-CMDB-014, ADR-037); nil leaves stored parts alone.
	Components []Component `json:"components,omitempty"`
}

// CiRef is either {id} or {type, identity}; exactly one form is populated.
type CiRef struct {
	ID       string            `json:"id,omitempty"`
	Type     string            `json:"type,omitempty"`
	Identity map[string]string `json:"identity,omitempty"`
}

type ObservedRelationship struct {
	Type       string         `json:"type"`
	From       CiRef          `json:"from"`
	To         CiRef          `json:"to"`
	Attributes map[string]any `json:"attributes"`
	ObservedAt time.Time      `json:"observedAt"`
}

type Evidence struct {
	Kind       string    `json:"kind"`
	Target     Target    `json:"target"`
	Digest     string    `json:"digest"`
	SizeBytes  int       `json:"sizeBytes"`
	CapturedAt time.Time `json:"capturedAt"`
}

type CollectorError struct {
	Target    *Target `json:"target"`
	Code      string  `json:"code"`
	Message   string  `json:"message"`
	Retryable bool    `json:"retryable"`
}

// MetricSample is one measurement taken on an observed CI (ADR-016, contract 0.2.0). Ci is referenced
// by identity like a relationship endpoint; the reconciler resolves it and stores the sample in ClickHouse.
type MetricSample struct {
	Ci     CiRef             `json:"ci"`
	Metric string            `json:"metric"`
	Ts     time.Time         `json:"ts"`
	Value  float64           `json:"value"`
	Unit   string            `json:"unit"`
	Labels map[string]string `json:"labels"`
}

type Metrics struct {
	TargetsAttempted     int `json:"targetsAttempted"`
	TargetsReached       int `json:"targetsReached"`
	CisEmitted           int `json:"cisEmitted"`
	RelationshipsEmitted int `json:"relationshipsEmitted"`
	DurationMs           int `json:"durationMs"`
}

type Result struct {
	JobID           string                 `json:"jobId"`
	RunID           string                 `json:"runId"`
	TenantID        string                 `json:"tenantId"`
	CollectorID     string                 `json:"collectorId"`
	NodeID          string                 `json:"nodeId"`
	Status          string                 `json:"status"`
	StartedAt       time.Time              `json:"startedAt"`
	FinishedAt      time.Time              `json:"finishedAt"`
	Cis             []ObservedCi           `json:"cis"`
	Relationships   []ObservedRelationship `json:"relationships"`
	Evidence        []Evidence             `json:"evidence"`
	Errors          []CollectorError       `json:"errors"`
	Samples         []MetricSample         `json:"samples,omitempty"`
	Metrics         Metrics                `json:"metrics"`
	ContractVersion string                 `json:"contractVersion"`
}

type Manifest struct {
	ID              string   `json:"id"`
	Family          string   `json:"family"`
	Version         string   `json:"version"`
	Language        string   `json:"language"`
	Protocols       []string `json:"protocols"`
	CredentialTypes []string `json:"credentialTypes"`
	TargetKinds     []string `json:"targetKinds"`
	Emits           []string `json:"emits"`
	ContractVersion string   `json:"contractVersion"`
}

// Statuses and error codes as the contract enumerates them.
const (
	StatusSuccess = "success"
	StatusPartial = "partial"
	StatusFailed  = "failed"

	ErrUnreachable       = "unreachable"
	ErrAuthFailed        = "auth_failed"
	ErrTimeout           = "timeout"
	ErrUnsupportedDevice = "unsupported_device"
	ErrParse             = "parse_error"
	ErrRateLimited       = "rate_limited"
	ErrPermissionDenied  = "permission_denied"
	ErrInternal          = "internal"
)

// Credential is what the Node hands a collector after resolving the job's credentialRef from OpenBao.
// Collectors never see the vault; they receive this on stdin alongside the job.
type Credential struct {
	Type      string            `json:"type"`
	Fields    map[string]string `json:"fields"`
	ExpiresAt *time.Time        `json:"expiresAt,omitempty"`
}

// Invocation is the single JSON document a collector reads from stdin.
type Invocation struct {
	Job        Job         `json:"job"`
	Credential *Credential `json:"credential"`
	RunID      string      `json:"runId"`
	// EvidenceDir is where the collector writes raw evidence bytes under <dir>/<kind>/<digest[:2]>/<digest>;
	// the Node owns the directory and the Result only carries digests. Empty means do not store.
	EvidenceDir string `json:"evidenceDir,omitempty"`
}
