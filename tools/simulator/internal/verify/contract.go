// REQ-QA-005 — contract checks on a collector result, read from the emitted JSON Schemas in packages/contracts: CI and
// relationship types are contract enum values, identity values are non-empty strings, names are set, and attribute
// values are scalars or arrays of scalars. The scheduler rejects a result that breaks any of these (found in simulated
// mode on the full stack: Pure reported its controllers as an array of objects), so a run that breaks one fails.
package verify

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

type enumSchema struct {
	Properties struct {
		Type struct {
			Enum []string `json:"enum"`
		} `json:"type"`
	} `json:"properties"`
}

// Contract holds the enums a result is checked against.
type Contract struct {
	CiTypes  map[string]bool
	RelTypes map[string]bool
}

func readEnum(path string) (map[string]bool, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var s enumSchema
	if err := json.Unmarshal(raw, &s); err != nil {
		return nil, err
	}
	if len(s.Properties.Type.Enum) == 0 {
		return nil, fmt.Errorf("%s: no type enum", path)
	}
	out := map[string]bool{}
	for _, v := range s.Properties.Type.Enum {
		out[v] = true
	}
	return out, nil
}

// LoadContract reads the observed CI and relationship schemas under the repository.
func LoadContract(repo string) (*Contract, error) {
	dir := filepath.Join(repo, "packages", "contracts", "schemas")
	ci, err := readEnum(filepath.Join(dir, "observed-ci.schema.json"))
	if err != nil {
		return nil, err
	}
	rel, err := readEnum(filepath.Join(dir, "observed-relationship.schema.json"))
	if err != nil {
		return nil, err
	}
	return &Contract{CiTypes: ci, RelTypes: rel}, nil
}

func scalar(v any) bool {
	switch v.(type) {
	case nil, string, float64, bool:
		return true
	}
	return false
}

func validAttribute(v any) bool {
	if scalar(v) {
		return true
	}
	arr, ok := v.([]any)
	if !ok {
		return false
	}
	for _, item := range arr {
		if !scalar(item) {
			return false
		}
	}
	return true
}

func identityProblem(identity map[string]string) string {
	if len(identity) == 0 {
		return "empty identity"
	}
	for k, v := range identity {
		if k == "" || v == "" {
			return fmt.Sprintf("identity %q has an empty key or value", k)
		}
	}
	return ""
}

// Violations lists every contract violation in a result (capped at limit).
func (c *Contract) Violations(res *Result, limit int) []string {
	var out []string
	add := func(format string, args ...any) {
		if len(out) < limit {
			out = append(out, fmt.Sprintf(format, args...))
		}
	}
	for _, ci := range res.Cis {
		if !c.CiTypes[ci.Type] {
			add("CI %q: type %q is not a contract CI type", ci.Name, ci.Type)
		}
		if ci.Name == "" {
			add("CI of type %s has no name", ci.Type)
		}
		if p := identityProblem(ci.Identity); p != "" {
			add("CI %q: %s", ci.Name, p)
		}
		for k, v := range ci.Attributes {
			if !validAttribute(v) {
				add("CI %q: attribute %q is not a scalar or an array of scalars", ci.Name, k)
			}
		}
	}
	for _, r := range res.Relationships {
		if !c.RelTypes[r.Type] {
			add("relationship type %q is not a contract relationship type", r.Type)
		}
		for _, end := range []ciRef{r.From, r.To} {
			if end.ID == "" {
				if !c.CiTypes[end.Type] {
					add("%s relationship end: type %q is not a contract CI type", r.Type, end.Type)
				}
				if p := identityProblem(end.Identity); p != "" {
					add("%s relationship end %s: %s", r.Type, end.Type, p)
				}
			}
		}
	}
	return out
}
