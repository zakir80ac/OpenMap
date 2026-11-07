// REQ-QA-005 — simulated mode: loads a synthetic estate (tools/synth-estate output: one collector result per
// ndjson line) into an index the vendor simulators render their APIs from. The estate is the single source of
// simulated truth, so a collector run against a simulator can be compared back to it.
package estate

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

// Ref is either {id} or {type, identity}, as in the collector contract.
type Ref struct {
	ID       string            `json:"id,omitempty"`
	Type     string            `json:"type,omitempty"`
	Identity map[string]string `json:"identity,omitempty"`
}

type CI struct {
	Type        string            `json:"type"`
	Identity    map[string]string `json:"identity"`
	Name        string            `json:"name"`
	Attributes  map[string]any    `json:"attributes"`
	Tags        []string          `json:"tags"`
	Components  []map[string]any  `json:"components,omitempty"`
	ExternalIDs []map[string]any  `json:"externalIds"`
	// Source is the synthetic collector id whose result carried the CI.
	Source string `json:"-"`
}

type Rel struct {
	Type       string         `json:"type"`
	From       Ref            `json:"from"`
	To         Ref            `json:"to"`
	Attributes map[string]any `json:"attributes"`
	Source     string         `json:"-"`
}

type result struct {
	TenantID      string `json:"tenantId"`
	CollectorID   string `json:"collectorId"`
	Cis           []*CI  `json:"cis"`
	Relationships []*Rel `json:"relationships"`
}

type Estate struct {
	Dir      string
	TenantID string
	CIs      []*CI
	Rels     []*Rel
	byKey    map[string]*CI
	from     map[*CI][]*Rel
	to       map[*CI][]*Rel
}

// Key is the stable identity key of a CI: its type and its identity map in sorted key order.
func Key(ciType string, identity map[string]string) string {
	keys := make([]string, 0, len(identity))
	for k := range identity {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var b strings.Builder
	b.WriteString(ciType)
	for _, k := range keys {
		b.WriteString("|" + k + "=" + identity[k])
	}
	return b.String()
}

// Load reads every *.ndjson result in dir.
func Load(dir string) (*Estate, error) {
	files, err := filepath.Glob(filepath.Join(dir, "*.ndjson"))
	if err != nil {
		return nil, err
	}
	if len(files) == 0 {
		return nil, fmt.Errorf("no *.ndjson results in %s (generate one with tools/synth-estate)", dir)
	}
	sort.Strings(files)
	e := &Estate{Dir: dir, byKey: map[string]*CI{}, from: map[*CI][]*Rel{}, to: map[*CI][]*Rel{}}
	for _, f := range files {
		if err := e.loadFile(f); err != nil {
			return nil, fmt.Errorf("%s: %w", f, err)
		}
	}
	for _, r := range e.Rels {
		if a := e.Resolve(r.From); a != nil {
			e.from[a] = append(e.from[a], r)
		}
		if b := e.Resolve(r.To); b != nil {
			e.to[b] = append(e.to[b], r)
		}
	}
	return e, nil
}

func (e *Estate) loadFile(path string) error {
	fh, err := os.Open(path)
	if err != nil {
		return err
	}
	defer fh.Close()
	sc := bufio.NewScanner(fh)
	sc.Buffer(make([]byte, 0, 1<<20), 1<<30)
	for sc.Scan() {
		line := sc.Bytes()
		if len(strings.TrimSpace(string(line))) == 0 {
			continue
		}
		var r result
		if err := json.Unmarshal(line, &r); err != nil {
			return err
		}
		if e.TenantID == "" {
			e.TenantID = r.TenantID
		}
		for _, c := range r.Cis {
			c.Source = r.CollectorID
			if c.Attributes == nil {
				c.Attributes = map[string]any{}
			}
			k := Key(c.Type, c.Identity)
			if _, dup := e.byKey[k]; dup {
				continue
			}
			e.byKey[k] = c
			e.CIs = append(e.CIs, c)
		}
		for _, rel := range r.Relationships {
			rel.Source = r.CollectorID
			e.Rels = append(e.Rels, rel)
		}
	}
	return sc.Err()
}

func (e *Estate) Resolve(ref Ref) *CI {
	if ref.Type == "" {
		return nil
	}
	return e.byKey[Key(ref.Type, ref.Identity)]
}

// OfType returns the CIs of a type (in estate order) that satisfy keep (nil keeps all).
func (e *Estate) OfType(ciType string, keep func(*CI) bool) []*CI {
	var out []*CI
	for _, c := range e.CIs {
		if c.Type == ciType && (keep == nil || keep(c)) {
			out = append(out, c)
		}
	}
	return out
}

// From returns the targets of relationships of relType leaving c ("" means any type).
func (e *Estate) From(c *CI, relType string) []*CI {
	var out []*CI
	for _, r := range e.from[c] {
		if relType == "" || r.Type == relType {
			if t := e.Resolve(r.To); t != nil {
				out = append(out, t)
			}
		}
	}
	return out
}

// To returns the sources of relationships of relType arriving at c.
func (e *Estate) To(c *CI, relType string) []*CI {
	var out []*CI
	for _, r := range e.to[c] {
		if relType == "" || r.Type == relType {
			if s := e.Resolve(r.From); s != nil {
				out = append(out, s)
			}
		}
	}
	return out
}

// Str returns a string attribute ("" when absent); numbers and booleans are formatted.
func (c *CI) Str(key string) string {
	switch v := c.Attributes[key].(type) {
	case string:
		return v
	case float64:
		return strconv.FormatFloat(v, 'f', -1, 64)
	case bool:
		return strconv.FormatBool(v)
	default:
		return ""
	}
}

// Num returns a numeric attribute (fallback when absent or not a number).
func (c *CI) Num(key string, fallback float64) float64 {
	switch v := c.Attributes[key].(type) {
	case float64:
		return v
	case string:
		if f, err := strconv.ParseFloat(v, 64); err == nil {
			return f
		}
	}
	return fallback
}

func (c *CI) Bool(key string) bool {
	b, _ := c.Attributes[key].(bool)
	return b
}

// Strs returns a string-array attribute.
func (c *CI) Strs(key string) []string {
	arr, _ := c.Attributes[key].([]any)
	out := make([]string, 0, len(arr))
	for _, v := range arr {
		if s, ok := v.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

// ID returns an identity value.
func (c *CI) ID(key string) string { return c.Identity[key] }
