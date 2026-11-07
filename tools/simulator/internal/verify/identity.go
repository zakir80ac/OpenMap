// REQ-QA-005 — identity drift judged the way reconciliation judges a merge (REQ-CORE-013,
// apps/reconciler/src/core/identity.ts): an observation updates a stored CI when its full identity tuple is equal, or
// when any globally unique key (serial number, FQDN, address, moRef…) carries the same value. The rules come from
// packages/contracts/schemas/ci-identity.json, emitted from CI_IDENTITY_KEYS and GLOBAL_IDENTITY_KEYS, so the harness
// and the reconciler cannot disagree on what "would merge" means.
package verify

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/openmap/openmap/tools/simulator/internal/estate"
)

// IdentityRules are the contract's identity keys per CI type, in precedence order, and the globally unique keys.
type IdentityRules struct {
	Keys   map[string][]string `json:"keys"`
	Global []string            `json:"global"`
	global map[string]bool
}

// LoadIdentityRules reads ci-identity.json under the repository.
func LoadIdentityRules(repo string) (*IdentityRules, error) {
	path := filepath.Join(repo, "packages", "contracts", "schemas", "ci-identity.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var r IdentityRules
	if err := json.Unmarshal(raw, &r); err != nil {
		return nil, err
	}
	if len(r.Keys) == 0 || len(r.Global) == 0 {
		return nil, fmt.Errorf("%s: no identity keys", path)
	}
	r.index()
	return &r, nil
}

func (r *IdentityRules) index() {
	r.global = map[string]bool{}
	for _, k := range r.Global {
		r.global[k] = true
	}
}

func normIdentity(v string) string { return strings.ToLower(strings.TrimSpace(v)) }

// tuple is the reconciler's canonical tuple: every present identity value in precedence order.
func (r *IdentityRules) tuple(ciType string, identity map[string]string) string {
	var parts []string
	for _, k := range r.Keys[ciType] {
		if v := identity[k]; v != "" {
			parts = append(parts, normIdentity(v))
		}
	}
	return strings.Join(parts, "|")
}

// Merges reports whether an observation with identity b would update the stored CI with identity a.
func (r *IdentityRules) Merges(ciType string, a, b map[string]string) bool {
	if t := r.tuple(ciType, a); t != "" && t == r.tuple(ciType, b) {
		return true
	}
	for _, k := range r.Keys[ciType] {
		if !r.global[k] {
			continue
		}
		av, bv := a[k], b[k]
		if av != "" && bv != "" && normIdentity(av) == normIdentity(bv) {
			return true
		}
	}
	return false
}

// DriftKey names a drift by type and the identity keys whose values differ, for the report's breakdown.
func DriftKey(ciType string, a, b map[string]string) string {
	seen := map[string]bool{}
	var keys []string
	for _, m := range []map[string]string{a, b} {
		for k := range m {
			if !seen[k] && normIdentity(a[k]) != normIdentity(b[k]) {
				seen[k] = true
				keys = append(keys, k)
			}
		}
	}
	sort.Strings(keys)
	return ciType + ":" + strings.Join(keys, ",")
}

// ApplyAliases rewrites the simulated addresses a collector saw into the estate's names for those targets. A
// collector that keys a CI by the address it dialled (vCenter moRefs, DHCP servers, bucket endpoints) reports the
// simulator's loopback address; against the real product it reports the target's own name. Longer aliases are
// applied first, so "127.0.0.1:443" wins over "127.0.0.1".
func ApplyAliases(res *Result, aliases map[string]string) {
	if len(aliases) == 0 {
		return
	}
	from := make([]string, 0, len(aliases))
	for k := range aliases {
		from = append(from, k)
	}
	sort.Slice(from, func(i, j int) bool { return len(from[i]) > len(from[j]) })
	rewrite := func(identity map[string]string) {
		for k, v := range identity {
			for _, f := range from {
				if v == f {
					identity[k] = aliases[f]
					break
				}
				if strings.HasPrefix(v, f+":") || strings.HasPrefix(v, f+"/") {
					identity[k] = aliases[f] + v[len(f):]
					break
				}
			}
		}
	}
	for i := range res.Cis {
		rewrite(res.Cis[i].Identity)
	}
	for i := range res.Relationships {
		rewrite(res.Relationships[i].From.Identity)
		rewrite(res.Relationships[i].To.Identity)
	}
}

// EstateIndex finds the estate CI an observation would merge into, with the reconciler's lookup keys: the full tuple
// first, then each globally unique key.
type EstateIndex struct {
	rules *IdentityRules
	byKey map[string]*estate.CI
}

func (r *IdentityRules) lookupKeys(ciType string, identity map[string]string) []string {
	var out []string
	if t := r.tuple(ciType, identity); t != "" {
		out = append(out, ciType+"|tuple="+t)
	}
	for _, k := range r.Keys[ciType] {
		if v := identity[k]; v != "" && r.global[k] {
			out = append(out, ciType+"|"+k+"="+normIdentity(v))
		}
	}
	return out
}

// NewEstateIndex indexes every estate CI by its lookup keys. The first CI to claim a key keeps it.
func NewEstateIndex(e *estate.Estate, rules *IdentityRules) *EstateIndex {
	ix := &EstateIndex{rules: rules, byKey: map[string]*estate.CI{}}
	for _, c := range e.CIs {
		for _, k := range rules.lookupKeys(c.Type, c.Identity) {
			if _, taken := ix.byKey[k]; !taken {
				ix.byKey[k] = c
			}
		}
	}
	return ix
}

// Lookup returns the estate CI an observed reference resolves to, or nil.
func (ix *EstateIndex) Lookup(ciType string, identity map[string]string) *estate.CI {
	for _, k := range ix.rules.lookupKeys(ciType, identity) {
		if c, ok := ix.byKey[k]; ok {
			return c
		}
	}
	return nil
}

// RelationshipDrift counts emitted relationships whose two ends are estate CIs the estate links differently: another
// type, or the same type the other way round, where the collector does not also emit the estate's link. Each key reads
// "<from> <type> <to> | estate: <from> <type> <to>". Relationships between CIs the estate does not link at all, and
// extra links beside one the collector also reports (Redfish's host contains bmc beside bmc manages host), are not
// drift: the collector sees more than the estate models.
func RelationshipDrift(res *Result, e *estate.Estate, ix *EstateIndex) map[string]int {
	type edge struct {
		from, to *estate.CI
		typ      string
	}
	type end struct{ from, to *estate.CI }
	resolved := make([]end, len(res.Relationships))
	emitted := map[edge]bool{}
	for i, r := range res.Relationships {
		a := ix.Lookup(r.From.Type, r.From.Identity)
		b := ix.Lookup(r.To.Type, r.To.Identity)
		resolved[i] = end{a, b}
		if a != nil && b != nil {
			emitted[edge{a, b, r.Type}] = true
		}
	}
	out := map[string]int{}
	for i, r := range res.Relationships {
		a, b := resolved[i].from, resolved[i].to
		if a == nil || b == nil || a == b {
			continue
		}
		between := e.Between(a, b)
		if len(between) == 0 || hasEdge(e, between, a, r.Type) {
			continue
		}
		var other *estate.Rel
		reported := false
		for _, er := range between {
			if emitted[edge{e.Resolve(er.From), e.Resolve(er.To), er.Type}] {
				reported = true
				break
			}
			if other == nil {
				other = er
			}
		}
		if reported || other == nil {
			continue
		}
		from, to := e.Resolve(other.From), e.Resolve(other.To)
		key := r.From.Type + " " + r.Type + " " + r.To.Type + " | estate: " + from.Type + " " + other.Type + " " + to.Type
		out[key]++
	}
	return out
}

// hasEdge reports whether among the relationships between two CIs one of relType leaves from.
func hasEdge(e *estate.Estate, between []*estate.Rel, from *estate.CI, relType string) bool {
	for _, er := range between {
		if er.Type == relType && e.Resolve(er.From) == from {
			return true
		}
	}
	return false
}
