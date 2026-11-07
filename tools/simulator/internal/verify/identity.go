// REQ-QA-005 REQ-CORE-013 — identity drift judged the way reconciliation judges a merge (apps/reconciler/src/core/
// identity.ts, packages/contracts/src/identity.ts): an observation updates a stored CI when its full identity tuple is
// equal, when its tuple with every `*Ref` resolved to the CI the ref names is equal (ADR-045), or when any globally
// unique key (serial number, FQDN, address…) carries the same value, together with its issuer's scope keys where the
// contract scopes it (a SaaS tenant id per vendor, a cloud resource id per provider). The rules come from
// packages/contracts/schemas/ci-identity.json, so the harness and the reconciler cannot disagree on what "would merge"
// means. Refs resolve against the estate: the estate is the store a discovery run reconciles into.
package verify

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/openmap/openmap/tools/simulator/internal/estate"
)

// RefDerived is a ref spelling derived from identity values: prefix + the values joined by separator.
type RefDerived struct {
	Keys      []string `json:"keys"`
	Prefix    string   `json:"prefix"`
	Separator string   `json:"separator"`
}

// IdentityRules are the contract's identity keys per CI type, in precedence order, the globally unique keys and their
// issuer scopes, and how a `*Ref` value names a CI.
type IdentityRules struct {
	Keys               map[string][]string `json:"keys"`
	Global             []string            `json:"global"`
	Scopes             map[string][]string `json:"scopes"`
	ParentKeys         map[string][]string `json:"parentKeys"`
	RefTargets         map[string][]string `json:"refTargets"`
	RefAliasAttributes []string            `json:"refAliasAttributes"`
	RefDerived         []RefDerived        `json:"refDerived"`
	global             map[string]bool
	targetTypes        map[string]bool
}

// Ranks of a ref token, as REF_TIER in packages/contracts: an identity value outranks a name or attribute.
const (
	tierIdentity = 0
	tierAlias    = 1
)

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
	if len(r.Keys) == 0 || len(r.Global) == 0 || len(r.RefTargets) == 0 {
		return nil, fmt.Errorf("%s: no identity keys or ref targets", path)
	}
	r.index()
	return &r, nil
}

func (r *IdentityRules) index() {
	r.global = map[string]bool{}
	for _, k := range r.Global {
		r.global[k] = true
	}
	r.targetTypes = map[string]bool{}
	for _, types := range r.RefTargets {
		for _, t := range types {
			r.targetTypes[t] = true
		}
	}
}

func normIdentity(v string) string { return strings.ToLower(strings.TrimSpace(v)) }

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

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

// isGlobal reports whether a key is globally unique in a type: a global key that is not the type's parent key.
func (r *IdentityRules) isGlobal(ciType, key string) bool {
	return r.global[key] && !contains(r.ParentKeys[ciType], key)
}

// isRef reports whether an identity key names another CI.
func (r *IdentityRules) isRef(key string) bool { return len(r.RefTargets[key]) > 0 }

// globalKeys are the lookup keys of the globally unique values, each with the scope keys its type declares; a scoped
// key whose scope value is missing is left out.
func (r *IdentityRules) globalKeys(ciType string, identity map[string]string) []string {
	declared := r.Keys[ciType]
	var out []string
	for _, k := range declared {
		v := identity[k]
		if v == "" || !r.isGlobal(ciType, k) {
			continue
		}
		parts := []string{}
		complete := true
		for _, s := range r.Scopes[k] {
			if !contains(declared, s) {
				continue
			}
			if identity[s] == "" {
				complete = false
				break
			}
			parts = append(parts, s+"="+normIdentity(identity[s]))
		}
		if !complete {
			continue
		}
		parts = append(parts, k+"="+normIdentity(v))
		out = append(out, ciType+"|"+strings.Join(parts, "|"))
	}
	return out
}

// refTokens are the spellings under which a ref may name the CI, with their rank (packages/contracts refTokensOf).
func (r *IdentityRules) refTokens(c *estate.CI) map[string]int {
	out := map[string]int{}
	if !r.targetTypes[c.Type] {
		return out
	}
	put := func(v string, tier int) {
		if strings.TrimSpace(v) == "" {
			return
		}
		t := normIdentity(v)
		if prev, ok := out[t]; !ok || tier < prev {
			out[t] = tier
		}
	}
	keys := r.Keys[c.Type]
	for _, k := range keys {
		if r.isGlobal(c.Type, k) {
			put(c.Identity[k], tierIdentity)
		}
	}
	put(r.tuple(c.Type, c.Identity), tierIdentity)
	for _, d := range r.RefDerived {
		values := make([]string, 0, len(d.Keys))
		for _, k := range d.Keys {
			if c.Identity[k] == "" {
				values = nil
				break
			}
			values = append(values, c.Identity[k])
		}
		if len(values) == len(d.Keys) {
			put(d.Prefix+strings.Join(values, d.Separator), tierIdentity)
		}
	}
	put(c.Name, tierAlias)
	for _, a := range r.RefAliasAttributes {
		switch v := c.Attributes[a].(type) {
		case string:
			put(v, tierAlias)
		case []any:
			for _, item := range v {
				if s, ok := item.(string); ok {
					put(s, tierAlias)
				}
			}
		}
	}
	for _, k := range keys {
		if _, ok := r.RefTargets[k]; ok {
			put(c.Identity[k], tierAlias)
		}
	}
	return out
}

// RefIndex resolves a `*Ref` value to the estate CI it names: the one CI of the ref's target types that carries the
// value at the best rank present, or nil when none or several do.
type RefIndex struct {
	rules   *IdentityRules
	byToken map[string]map[*estate.CI]int
}

// NewRefIndex indexes the ref tokens of every estate CI.
func NewRefIndex(e *estate.Estate, rules *IdentityRules) *RefIndex {
	ix := &RefIndex{rules: rules, byToken: map[string]map[*estate.CI]int{}}
	for _, c := range e.CIs {
		for t, tier := range rules.refTokens(c) {
			m := ix.byToken[t]
			if m == nil {
				m = map[*estate.CI]int{}
				ix.byToken[t] = m
			}
			if prev, ok := m[c]; !ok || tier < prev {
				m[c] = tier
			}
		}
	}
	return ix
}

// Resolve returns the estate CI a ref value names, or nil.
func (ix *RefIndex) Resolve(refKey, value string) *estate.CI {
	if ix == nil {
		return nil
	}
	targets := ix.rules.RefTargets[refKey]
	if len(targets) == 0 {
		return nil
	}
	best := math.MaxInt
	var found *estate.CI
	n := 0
	for c, tier := range ix.byToken[normIdentity(value)] {
		if !contains(targets, c.Type) {
			continue
		}
		switch {
		case tier < best:
			best, found, n = tier, c, 1
		case tier == best:
			n++
		}
	}
	if n != 1 {
		return nil
	}
	return found
}

// refKey is the tuple with every ref resolved to the estate CI it names, or "" when the type carries no ref or one does
// not resolve.
func (r *IdentityRules) refKey(ciType string, identity map[string]string, refs *RefIndex) string {
	if refs == nil {
		return ""
	}
	resolved := false
	var parts []string
	for _, k := range r.Keys[ciType] {
		v := identity[k]
		if v == "" {
			continue
		}
		if r.isRef(k) {
			c := refs.Resolve(k, v)
			if c == nil {
				return ""
			}
			parts = append(parts, "@"+estate.Key(c.Type, c.Identity))
			resolved = true
			continue
		}
		parts = append(parts, normIdentity(v))
	}
	if !resolved {
		return ""
	}
	return ciType + "|ref=" + strings.Join(parts, "|")
}

// Merges reports whether an observation with identity b would update the stored CI with identity a. refs resolves
// `*Ref` values (nil compares them as written).
func (r *IdentityRules) Merges(ciType string, a, b map[string]string, refs *RefIndex) bool {
	if t := r.tuple(ciType, a); t != "" && t == r.tuple(ciType, b) {
		return true
	}
	if k := r.refKey(ciType, a, refs); k != "" && k == r.refKey(ciType, b, refs) {
		return true
	}
	ga := map[string]bool{}
	for _, k := range r.globalKeys(ciType, a) {
		ga[k] = true
	}
	for _, k := range r.globalKeys(ciType, b) {
		if ga[k] {
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
// first, then the tuple with refs resolved, then each globally unique key.
type EstateIndex struct {
	rules *IdentityRules
	Refs  *RefIndex
	byKey map[string]*estate.CI
}

func (r *IdentityRules) lookupKeys(ciType string, identity map[string]string, refs *RefIndex) []string {
	var out []string
	if t := r.tuple(ciType, identity); t != "" {
		out = append(out, ciType+"|tuple="+t)
	}
	if k := r.refKey(ciType, identity, refs); k != "" {
		out = append(out, k)
	}
	return append(out, r.globalKeys(ciType, identity)...)
}

// NewEstateIndex indexes every estate CI by its lookup keys. The first CI to claim a key keeps it.
func NewEstateIndex(e *estate.Estate, rules *IdentityRules) *EstateIndex {
	ix := &EstateIndex{rules: rules, Refs: NewRefIndex(e, rules), byKey: map[string]*estate.CI{}}
	for _, c := range e.CIs {
		for _, k := range rules.lookupKeys(c.Type, c.Identity, ix.Refs) {
			if _, taken := ix.byKey[k]; !taken {
				ix.byKey[k] = c
			}
		}
	}
	return ix
}

// Lookup returns the estate CI an observed reference resolves to, or nil.
func (ix *EstateIndex) Lookup(ciType string, identity map[string]string) *estate.CI {
	for _, k := range ix.rules.lookupKeys(ciType, identity, ix.Refs) {
		if c, ok := ix.byKey[k]; ok {
			return c
		}
	}
	return nil
}

// Collisions lists pairs of distinct estate CIs that share a lookup key: two CIs reconciliation would merge into one.
// Each entry reads "<type> <name> | <name> (<key>)".
func (ix *EstateIndex) Collisions(e *estate.Estate) []string {
	owner := map[string]*estate.CI{}
	var out []string
	for _, c := range e.CIs {
		for _, k := range ix.rules.lookupKeys(c.Type, c.Identity, ix.Refs) {
			if o, taken := owner[k]; taken && o != c {
				out = append(out, c.Type+" "+o.Name+" | "+c.Name+" ("+k+")")
				break
			}
			owner[k] = c
		}
	}
	return out
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
