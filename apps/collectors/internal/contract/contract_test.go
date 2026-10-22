// T-094 REQ-CORE-002 — the collectors copy of the Go contract view stays in step with the JSON Schema emitted from the
// zod definitions: every required property has a field with that JSON tag, every tagged field names a property,
// nested objects and array items are checked the same way, and the version constant matches the schemas.
package contract

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

type schemaNode struct {
	Version    string                 `json:"version"`
	Properties map[string]*schemaNode `json:"properties"`
	Required   []string               `json:"required"`
	Items      *schemaNode            `json:"items"`
	AnyOf      []*schemaNode          `json:"anyOf"`
}

func loadSchema(t *testing.T, name string) *schemaNode {
	t.Helper()
	path := filepath.Join("..", "..", "..", "..", "packages", "contracts", "schemas", name+".schema.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v (run `pnpm --filter @openmap/contracts build` first)", path, err)
	}
	var s schemaNode
	if err := json.Unmarshal(raw, &s); err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}
	return &s
}

// objectView flattens anyOf alternatives (nullable objects, CiRef unions) into one property map; required
// properties are those every object alternative demands.
func objectView(s *schemaNode) (map[string]*schemaNode, []string) {
	if s.Properties != nil {
		return s.Properties, s.Required
	}
	props := map[string]*schemaNode{}
	var required []string
	first := true
	for _, alt := range s.AnyOf {
		if alt.Properties == nil {
			continue
		}
		for k, v := range alt.Properties {
			props[k] = v
		}
		if first {
			required = append([]string(nil), alt.Required...)
			first = false
		} else {
			required = intersect(required, alt.Required)
		}
	}
	return props, required
}

func intersect(a, b []string) []string {
	var out []string
	for _, x := range a {
		for _, y := range b {
			if x == y {
				out = append(out, x)
			}
		}
	}
	return out
}

func checkStruct(t *testing.T, path string, goType reflect.Type, s *schemaNode) {
	t.Helper()
	for goType.Kind() == reflect.Ptr {
		goType = goType.Elem()
	}
	if goType.Kind() != reflect.Struct || goType == reflect.TypeOf(time.Time{}) {
		return
	}
	props, required := objectView(s)
	if props == nil {
		t.Errorf("%s: schema has no object properties for Go struct %s", path, goType.Name())
		return
	}
	fields := map[string]reflect.StructField{}
	for i := 0; i < goType.NumField(); i++ {
		f := goType.Field(i)
		tag := strings.Split(f.Tag.Get("json"), ",")[0]
		if tag == "" || tag == "-" {
			continue
		}
		fields[tag] = f
		if _, ok := props[tag]; !ok {
			t.Errorf("%s.%s: Go field %s has no property in the schema", path, tag, f.Name)
		}
	}
	for _, r := range required {
		if _, ok := fields[r]; !ok {
			t.Errorf("%s.%s: required by the schema but missing from Go struct %s", path, r, goType.Name())
		}
	}
	for tag, f := range fields {
		prop, ok := props[tag]
		if !ok {
			continue
		}
		ft := f.Type
		for ft.Kind() == reflect.Ptr {
			ft = ft.Elem()
		}
		switch {
		case ft.Kind() == reflect.Slice && prop.Items != nil:
			checkStruct(t, path+"."+tag+"[]", ft.Elem(), prop.Items)
		case ft.Kind() == reflect.Struct:
			checkStruct(t, path+"."+tag, ft, prop)
		}
	}
}

func TestGoTypesMatchEmittedJSONSchema(t *testing.T) {
	cases := []struct {
		schema string
		goType reflect.Type
	}{
		{"collector-job", reflect.TypeOf(Job{})},
		{"collector-result", reflect.TypeOf(Result{})},
		{"collector-manifest", reflect.TypeOf(Manifest{})},
		{"observed-ci", reflect.TypeOf(ObservedCi{})},
		{"observed-relationship", reflect.TypeOf(ObservedRelationship{})},
	}
	for _, c := range cases {
		s := loadSchema(t, c.schema)
		if s.Version != Version {
			t.Errorf("%s: schema version %s, Go contract.Version %s", c.schema, s.Version, Version)
		}
		checkStruct(t, c.schema, c.goType, s)
	}
}

func TestResultRoundTripsThroughJSON(t *testing.T) {
	now := time.Date(2026, 10, 22, 9, 0, 0, 0, time.UTC)
	in := Result{
		JobID: "9b2c6a7e-0f6d-4c0b-9d7e-2a1f3b4c5d6e", RunID: "1b2c6a7e-0f6d-4c0b-9d7e-2a1f3b4c5d6e", TenantID: "2b2c6a7e-0f6d-4c0b-9d7e-2a1f3b4c5d6e",
		CollectorID: "port_scan", NodeID: "node-hq-01", Status: StatusSuccess, StartedAt: now, FinishedAt: now.Add(time.Second),
		Cis:           []ObservedCi{{Type: "host", Identity: map[string]string{"fqdn": "a.example"}, Name: "a", Attributes: map[string]any{}, Tags: []string{}, ExternalIDs: []ExternalID{}, ObservedAt: now}},
		Relationships: []ObservedRelationship{}, Evidence: []Evidence{}, Errors: []CollectorError{},
		Metrics:       Metrics{TargetsAttempted: 1, TargetsReached: 1, CisEmitted: 1}, ContractVersion: Version,
	}
	raw, err := json.Marshal(in)
	if err != nil {
		t.Fatal(err)
	}
	var out Result
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(in, out) {
		t.Errorf("round trip changed the result:\n in=%+v\nout=%+v", in, out)
	}
	var generic map[string]json.RawMessage
	if err := json.Unmarshal(raw, &generic); err != nil {
		t.Fatal(err)
	}
	_, required := objectView(loadSchema(t, "collector-result"))
	for _, r := range required {
		if _, ok := generic[r]; !ok {
			t.Errorf("marshalled result lacks required property %s", r)
		}
	}
}
