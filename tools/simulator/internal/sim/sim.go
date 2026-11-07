// REQ-QA-005 — simulated mode core: the Vendor interface every simulator implements, the run description
// handed to a real collector binary, and the expectation the verify harness checks its output against.
// Simulated responses follow the vendor's published API documentation and the collector's own parser; they
// are rendered from the synthetic estate and never stored as vendor fixtures (risk R-004, ADR-042).
package sim

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"strings"

	"github.com/openmap/openmap/tools/simulator/internal/estate"
)

// Provenance is stamped on every run so simulated results can never pass for recorded vendor evidence.
const Provenance = "simulated"

type Target struct {
	Kind  string `json:"kind"`
	Value string `json:"value"`
	Label string `json:"label,omitempty"`
}

type Credential struct {
	Type   string            `json:"type"`
	Fields map[string]string `json:"fields"`
}

// ExpectCI is a CI the collector must emit: matched on type and name. Identity, when set, is the estate's
// identity for the CI; a collector identity sharing no key and value with it is reported as drift (the
// reconciler would create a second CI instead of updating the estate's).
type ExpectCI struct {
	Type     string            `json:"type"`
	Name     string            `json:"name"`
	Identity map[string]string `json:"identity,omitempty"`
	// Attributes, when set, must each appear on the emitted CI with an equal value (compared as JSON).
	Attributes map[string]any `json:"attributes,omitempty"`
}

// ExpectRel is a relationship the collector must emit. Each end is an emitted CI matched by type and name,
// or, when FromIdentity/ToIdentity is set, a reference-only CI matched by those identity keys and values.
type ExpectRel struct {
	Type         string            `json:"type"`
	FromType     string            `json:"fromType"`
	From         string            `json:"from,omitempty"`
	FromIdentity map[string]string `json:"fromIdentity,omitempty"`
	ToType       string            `json:"toType"`
	To           string            `json:"to,omitempty"`
	ToIdentity   map[string]string `json:"toIdentity,omitempty"`
}

type Expect struct {
	CIs  []ExpectCI  `json:"cis"`
	Rels []ExpectRel `json:"relationships"`
}

func (x *Expect) CI(ciType, name string) { x.CIs = append(x.CIs, ExpectCI{Type: ciType, Name: name}) }

// EstateCI expects an estate CI under its own type and name, carrying its identity for the drift check.
func (x *Expect) EstateCI(c *estate.CI) {
	x.CIs = append(x.CIs, ExpectCI{Type: c.Type, Name: c.Name, Identity: c.Identity})
}

// CIWith expects a CI by type and name whose attributes include attrs, with the estate identity for the drift check.
func (x *Expect) CIWith(c *estate.CI, ciType string, attrs map[string]any) {
	x.CIs = append(x.CIs, ExpectCI{Type: ciType, Name: c.Name, Identity: c.Identity, Attributes: attrs})
}

// RelToRef expects a relationship from an emitted CI to a reference-only CI identified by identity.
func (x *Expect) RelToRef(relType, fromType, from, toType string, toIdentity map[string]string) {
	x.Rels = append(x.Rels, ExpectRel{Type: relType, FromType: fromType, From: from, ToType: toType, ToIdentity: toIdentity})
}

// RelFromRef expects a relationship from a reference-only CI to an emitted CI.
func (x *Expect) RelFromRef(relType, fromType string, fromIdentity map[string]string, toType, to string) {
	x.Rels = append(x.Rels, ExpectRel{Type: relType, FromType: fromType, FromIdentity: fromIdentity, ToType: toType, To: to})
}

func (x *Expect) Rel(relType, fromType, from, toType, to string) {
	x.Rels = append(x.Rels, ExpectRel{Type: relType, FromType: fromType, From: from, ToType: toType, To: to})
}

// Run is one collector invocation against a started simulator.
type Run struct {
	// Name distinguishes several runs of one vendor (for example one per SaaS provider).
	Name           string
	Targets        []Target
	Options        map[string]any
	CredentialType string
	Credential     *Credential
	Expect         Expect
	// TimeoutMs bounds the collector run; 0 uses the harness default.
	TimeoutMs int
	// Aliases maps an address the collector dials here (loopback, with or without its port) to the estate's name for
	// that target. The harness rewrites identity values the collector derived from the dialled address before the
	// drift check, because against the real product the collector would have dialled the target's own name.
	Aliases map[string]string
}

// Endpoint is a started simulator.
type Endpoint struct {
	// Host is the address collectors dial (always loopback).
	Host string
	// Port is the listening port (0 for simulators that dial the collector instead, such as flow exporters).
	Port int
	// URL is the base URL for HTTP simulators.
	URL string
	// Devices maps a device key to its own base URL when the simulator runs one listener per appliance.
	Devices map[string]string
	// State carries vendor-specific values from Start to Runs (generated secrets, extra ports).
	State map[string]any
	close []func() error
}

func (ep *Endpoint) OnClose(f func() error) { ep.close = append(ep.close, f) }

func (ep *Endpoint) Close() error {
	var first error
	for i := len(ep.close) - 1; i >= 0; i-- {
		if err := ep.close[i](); err != nil && first == nil {
			first = err
		}
	}
	return first
}

// Vendor is one simulated product (or product family) behind one collector.
type Vendor interface {
	// ID names the simulator, for example "vmware-vcenter".
	ID() string
	// Collector is the collector binary (the apps/collectors/cmd directory name).
	Collector() string
	// Requirements are the tracker rows the simulator exercises.
	Requirements() []string
	// Start serves the vendor API from the estate on loopback.
	Start(ctx context.Context, e *estate.Estate, env *Env) (*Endpoint, error)
	// Runs describe the collector invocations against the endpoint and what each must emit.
	Runs(e *estate.Estate, ep *Endpoint, env *Env) []Run
}

// Concurrent is implemented by simulators that must act while the collector runs (flow exporters, trap
// senders): Drive starts after the collector process and stops when ctx ends.
type Concurrent interface {
	Drive(ctx context.Context, e *estate.Estate, ep *Endpoint, run Run, env *Env) error
}

// Loopback by default: verify runs collectors on the same host. `simulator serve --bind 0.0.0.0 --advertise <name>`
// lets a containerised Discovery Node reach the simulators by service name (deploy/compose profile "simulated").
var (
	bindHost      = "127.0.0.1"
	advertiseHost = "127.0.0.1"
)

// Configure sets the listen address and the host name collectors are given. Call it before NewEnv: the server
// certificate names the advertised host.
func Configure(bind, advertise string) {
	if bind != "" {
		bindHost = bind
	}
	if advertise != "" {
		advertiseHost = advertise
	}
}

// AdvertiseHost is the host name or address collectors dial.
func AdvertiseHost() string { return advertiseHost }

// Env is shared by every simulator in one process.
type Env struct {
	CA *CA
	// Secret is the per-process credential every simulator accepts, so auth paths are exercised for real.
	Secret string
	// User is the account name simulators accept.
	User string
}

func NewEnv() (*Env, error) {
	ca, err := NewCA()
	if err != nil {
		return nil, err
	}
	buf := make([]byte, secretBytes)
	if _, err := rand.Read(buf); err != nil {
		return nil, err
	}
	return &Env{CA: ca, Secret: hex.EncodeToString(buf), User: simUser}, nil
}

const (
	secretBytes = 16
	simUser     = "openmap-sim"
)

// IsUUID reports whether s is a canonical 8-4-4-4-12 hexadecimal UUID, for simulators that serve an estate id when the
// estate carries the platform's own and derive one otherwise.
func IsUUID(s string) bool {
	if len(s) != uuidLen {
		return false
	}
	for i, r := range s {
		switch i {
		case 8, 13, 18, 23:
			if r != '-' {
				return false
			}
		default:
			if !strings.ContainsRune("0123456789abcdefABCDEF", r) {
				return false
			}
		}
	}
	return true
}

const uuidLen = 36
