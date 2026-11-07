// T-445 REQ-DISC-014 REQ-QA-005 — the array's attributes are scalars or arrays of scalars as the CI contract requires
// (the scheduler rejected Pure results whose controllers were an array of objects, found in simulated mode).
package purestorage

import (
	"testing"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

func TestArrayAttributesAreContractValues(t *testing.T) {
	inv := &Inventory{
		Array:       arrayDoc{ID: "a1", Name: "ryd-pure-01"},
		Hardware:    []hardwareDoc{{Name: "CH0", Type: "chassis", Serial: "PCT1"}},
		Controllers: []controllerDoc{{Name: "CT0", Mode: "primary", Status: "ready", Model: "FA-X90R4"}, {Name: "CT1", Mode: "secondary", Status: "ready", Model: "FA-X90R4"}},
	}
	obs := Emit(inv, contract.Target{Kind: "host", Value: "10.8.0.10"}, time.Now())
	attrs := obs.Cis[0].Attributes
	if attrs["controllers"] != 2 {
		t.Fatalf("controllers = %v", attrs["controllers"])
	}
	states, ok := attrs["controllerStates"].([]string)
	if !ok || len(states) != 2 || states[0] != "CT0 primary ready" {
		t.Fatalf("controllerStates = %#v", attrs["controllerStates"])
	}
	for k, v := range attrs {
		switch v.(type) {
		case string, int, int64, float64, bool, nil, []string:
		default:
			t.Errorf("attribute %q has a non-contract value %T", k, v)
		}
	}
}
