// REQ-QA-005 REQ-INT-017 — what the Veeam, Commvault and Rubrik simulators share (ADR-075): the estate's backup
// policies of one vendor with the covers (incoming backed_by edges) of each, the CMDB inventory a planner would put in
// the job (the key rules of inventoryKeysOf in packages/contracts/src/protection.ts), and the expectation every run is
// checked against: each policy CI by its estate identity and each cover from the protected CI's estate identity.
package backupsim

import (
	"sort"
	"strings"
	"time"

	"github.com/openmap/openmap/tools/simulator/internal/estate"
	"github.com/openmap/openmap/tools/simulator/internal/sim"
)

const (
	policyType = "backup_policy"
	relBacked  = "backed_by"
)

// Cover is one CI a policy protects, with the edge's attributes.
type Cover struct {
	CI    *estate.CI
	Attrs map[string]any
}

// Policy is one estate backup policy and its covers in estate order.
type Policy struct {
	CI     *estate.CI
	Covers []Cover
}

// Policies returns the vendor's policies in estate order.
func Policies(e *estate.Estate, vendor string) []*Policy {
	byCI := map[*estate.CI]*Policy{}
	var out []*Policy
	for _, c := range e.OfType(policyType, func(c *estate.CI) bool { return c.ID("vendor") == vendor }) {
		p := &Policy{CI: c}
		byCI[c] = p
		out = append(out, p)
	}
	for _, r := range e.Rels {
		if r.Type != relBacked {
			continue
		}
		to := e.Resolve(r.To)
		p, ok := byCI[to]
		if !ok {
			continue
		}
		if from := e.Resolve(r.From); from != nil {
			p.Covers = append(p.Covers, Cover{CI: from, Attrs: r.Attributes})
		}
	}
	return out
}

// Server is the vendor's backup server: its address and own id, from the first policy.
func Server(policies []*Policy) (host, serverID string) {
	if len(policies) == 0 {
		return "", ""
	}
	return policies[0].CI.Str("server"), policies[0].CI.ID("serverId")
}

// Str reads a string attribute.
func Str(m map[string]any, key string) string {
	s, _ := m[key].(string)
	return s
}

// Int reads a numeric attribute (JSON numbers decode as float64).
func Int(m map[string]any, key string) int {
	switch v := m[key].(type) {
	case float64:
		return int(v)
	case int:
		return v
	}
	return 0
}

// Strs reads a string-array attribute.
func Strs(m map[string]any, key string) []string {
	arr, _ := m[key].([]any)
	out := make([]string, 0, len(arr))
	for _, v := range arr {
		if s, ok := v.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

// Time reads an RFC 3339 attribute; ok is false when absent.
func Time(m map[string]any, key string) (time.Time, bool) {
	s := Str(m, key)
	if s == "" {
		return time.Time{}, false
	}
	t, err := time.Parse(time.RFC3339, s)
	return t.UTC(), err == nil
}

// Inventory is the job's inventory option: every estate VM and host with the keys a planner derives from the CMDB.
func Inventory(e *estate.Estate) []any {
	var out []any
	for _, c := range e.CIs {
		if c.Type != "vm" && c.Type != "host" {
			continue
		}
		identity := map[string]any{}
		for k, v := range c.Identity {
			identity[k] = v
		}
		keys := []any{}
		for _, k := range keysOf(c) {
			keys = append(keys, k)
		}
		out = append(out, map[string]any{"type": c.Type, "identity": identity, "keys": keys})
	}
	return out
}

func keysOf(c *estate.CI) []string {
	seen := map[string]bool{}
	var out []string
	put := func(v string) {
		v = strings.ToLower(strings.TrimSpace(v))
		if v != "" && !seen[v] {
			seen[v] = true
			out = append(out, v)
		}
	}
	put(c.Name)
	for _, k := range []string{"instanceUuid", "fqdn", "serialNumber", "systemUuid"} {
		put(c.ID(k))
	}
	for _, k := range []string{"fqdn", "hostname", "ipAddress", "primaryIp", "instanceUuid", "serialNumber"} {
		put(c.Str(k))
	}
	if vc, mo := c.Str("vcenter"), c.Str("moRef"); vc != "" && mo != "" {
		put(vc + ":" + mo)
	}
	return out
}

// Expect adds the run's expectations: every policy with its key attributes, every cover from its CI's estate identity.
func Expect(run *sim.Run, policies []*Policy) {
	for _, p := range policies {
		attrs := map[string]any{"policyKind": p.CI.Str("policyKind"), "protectedObjects": len(p.Covers), "unmatchedObjects": 0}
		for _, k := range []string{"rpoMinutes", "retentionDays", "retentionPoints"} {
			if v, ok := p.CI.Attributes[k]; ok {
				attrs[k] = v
			}
		}
		run.Expect.CIWith(p.CI, policyType, attrs)
		for _, c := range p.Covers {
			run.Expect.RelFromRef(relBacked, c.CI.Type, c.CI.Identity, policyType, p.CI.Name)
		}
	}
}

// Page slices items for an offset and limit.
func Page[T any](items []T, offset, limit int) ([]T, bool) {
	if offset < 0 {
		offset = 0
	}
	if offset > len(items) {
		offset = len(items)
	}
	end := len(items)
	if limit > 0 && offset+limit < end {
		end = offset + limit
	}
	return items[offset:end], end < len(items)
}

// SortedCovers returns covers ordered by object name, as products list them.
func SortedCovers(p *Policy) []Cover {
	out := append([]Cover(nil), p.Covers...)
	sort.SliceStable(out, func(i, j int) bool { return Str(out[i].Attrs, "objectName") < Str(out[j].Attrs, "objectName") })
	return out
}
