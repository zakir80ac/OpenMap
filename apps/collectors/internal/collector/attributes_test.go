// T-446 REQ-QA-005 — contract attributes: scalars and scalar arrays pass unchanged; flat maps become sorted key=value
// strings; object items in arrays and nested maps become compact JSON text; Execute applies it to every CI.
package collector

import (
	"reflect"
	"testing"
)

func TestContractAttributes(t *testing.T) {
	type disk struct {
		Name string `json:"name"`
		GB   int    `json:"gb"`
	}
	in := map[string]any{
		"name":    "esx-01",
		"cores":   64,
		"ratio":   3.5,
		"up":      true,
		"ips":     []string{"10.0.0.1"},
		"tags":    map[string]string{"env": "prod", "app": "core"},
		"counts":  map[string]int{"vm": 3},
		"disks":   []disk{{"sda", 480}},
		"mixed":   []any{"a", 1, map[string]any{"k": "v"}},
		"nested":  map[string]any{"a": map[string]any{"b": 1}},
		"nothing": nil,
	}
	out := ContractAttributes(in)
	want := map[string]any{
		"name": "esx-01", "cores": 64, "ratio": 3.5, "up": true, "ips": []string{"10.0.0.1"}, "nothing": nil,
		"tags":   []any{"app=core", "env=prod"},
		"counts": []any{"vm=3"},
		"disks":  []any{`{"gb":480,"name":"sda"}`},
		"mixed":  []any{"a", float64(1), `{"k":"v"}`},
		"nested": `{"a":{"b":1}}`,
	}
	for k, w := range want {
		if !reflect.DeepEqual(out[k], w) {
			t.Errorf("%s = %#v, want %#v", k, out[k], w)
		}
	}
	if len(ContractAttributes(nil)) != 0 {
		t.Error("nil attributes should become an empty map")
	}
}
