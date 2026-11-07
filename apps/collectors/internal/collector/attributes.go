// REQ-QA-005 REQ-CORE-001 — every observed CI leaves the collector with contract-valid attributes: scalars or arrays of
// scalars (CI contract, ci.ts). The scheduler rejects a whole result that breaks the rule, and simulated mode found
// twelve collectors reporting maps (tags, labels, counts per type) or lists of objects (switches, aggregates, disks,
// ports). The runtime converts them here, losslessly, so no collector can lose a sweep to an attribute's shape:
//   - a map whose values are all scalars becomes sorted "key=value" strings (tags and labels read as they do in the
//     vendors' own consoles);
//   - an array keeps its scalar items, and each non-scalar item becomes its compact JSON text;
//   - anything else nested (a map holding maps or arrays) becomes its compact JSON text.
package collector

import (
	"encoding/json"
	"fmt"
	"sort"
)

func isScalar(v any) bool {
	switch v.(type) {
	case nil, string, float64, bool, json.Number:
		return true
	}
	return false
}

func compactJSON(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		return fmt.Sprint(v)
	}
	return string(b)
}

func scalarText(v any) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return t
	default:
		return compactJSON(t)
	}
}

// contractValue converts one decoded JSON value into a contract attribute value.
func contractValue(v any) any {
	switch t := v.(type) {
	case []any:
		out := make([]any, 0, len(t))
		for _, item := range t {
			if isScalar(item) {
				out = append(out, item)
			} else {
				out = append(out, compactJSON(item))
			}
		}
		return out
	case map[string]any:
		keys := make([]string, 0, len(t))
		flat := true
		for k, item := range t {
			keys = append(keys, k)
			if !isScalar(item) {
				flat = false
			}
		}
		if !flat {
			return compactJSON(t)
		}
		sort.Strings(keys)
		out := make([]any, 0, len(keys))
		for _, k := range keys {
			out = append(out, k+"="+scalarText(t[k]))
		}
		return out
	default:
		return v
	}
}

// ContractAttributes returns attrs with every value made contract-valid. Values that already are scalars or scalar
// arrays come back unchanged (numbers keep their Go type).
func ContractAttributes(attrs map[string]any) map[string]any {
	if attrs == nil {
		return map[string]any{}
	}
	out := make(map[string]any, len(attrs))
	for k, v := range attrs {
		switch v.(type) {
		case nil, string, bool, int, int8, int16, int32, int64, uint, uint8, uint16, uint32, uint64, float32, float64, []string, []int, []int64, []float64, []bool:
			out[k] = v
			continue
		}
		raw, err := json.Marshal(v)
		if err != nil {
			out[k] = fmt.Sprint(v)
			continue
		}
		var decoded any
		if err := json.Unmarshal(raw, &decoded); err != nil {
			out[k] = string(raw)
			continue
		}
		out[k] = contractValue(decoded)
	}
	return out
}
