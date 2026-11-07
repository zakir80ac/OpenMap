// T-354 REQ-CMDB-024 — warranty parsing: the job's asset list, batching, calendar dates, Dell and Lenovo entitlements
// reduced to one cover, and the observed CI (serial identity, warranty and EoX attributes, vendor-sourced end of life).
package warranty

import (
	"encoding/json"
	"testing"
	"time"
)

func TestParseAssetsAndBatches(t *testing.T) {
	assets := ParseAssets(map[string]any{"assets": []any{
		map[string]any{"serialNumber": "ABC1234", "ciType": "host", "name": "esx-01"},
		map[string]any{"serialNumber": "abc1234"},
		map[string]any{"serialNumber": " FOC1"},
		map[string]any{"name": "no serial"},
		"not an object",
	}})
	if len(assets) != 2 || assets[1].SerialNumber != "FOC1" || assets[1].CiType != "host" || assets[1].Name != "FOC1" {
		t.Fatalf("assets: %+v", assets)
	}
	if b := Batches(append(assets, assets...), 3); len(b) != 2 || len(b[0]) != 3 || len(b[1]) != 1 {
		t.Fatalf("batches: %+v", b)
	}
}

func TestDay(t *testing.T) {
	for in, want := range map[string]string{
		"2024-01-02":                  "2024-01-02",
		"2023-01-02T23:59:59.000001Z": "2023-01-02",
		"2021-05-10T00:00:00+03:00":   "2021-05-09",
		"2026-11-07 08:00:00":         "2026-11-07",
		"soon":                        "",
		"":                            "",
	} {
		if got := Day(in); got != want {
			t.Errorf("Day(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestDellAndLenovoReduce(t *testing.T) {
	var d dellAsset
	if err := json.Unmarshal([]byte(`{"serviceTag":"ABC1234","shipDate":"2021-01-20T00:00:00Z","productLineDescription":"POWEREDGE R750","entitlements":[
		{"startDate":"2021-01-23T00:00:00Z","endDate":"2024-01-23T23:59:59.000001Z","entitlementType":"INITIAL","serviceLevelDescription":"Basic NBD"},
		{"startDate":"2024-01-24T00:00:00Z","endDate":"2026-01-23T23:59:59.000001Z","entitlementType":"EXTENDED","serviceLevelDescription":"ProSupport Plus 4h"}]}`), &d); err != nil {
		t.Fatal(err)
	}
	l := DellLookup(d)
	if l.Start != "2021-01-23" || l.End != "2026-01-23" || l.Level != "ProSupport Plus 4h" || l.ShipDate != "2021-01-20" {
		t.Fatalf("dell: %+v", l)
	}
	var w lenovoWarranty
	if err := json.Unmarshal([]byte(`{"Serial":"J30ABCDE","Product":"7D76CTO1WW","InWarranty":false,"Warranty":[
		{"Name":"Base Warranty","Type":"BASE","Start":"2024-08-22T00:00:00Z","End":"2027-08-21T00:00:00Z"},
		{"Name":"Premier Support 24x7x4","Type":"UPGRADE","Start":"2024-08-22T00:00:00Z","End":"2029-08-21T00:00:00Z"}]}`), &w); err != nil {
		t.Fatal(err)
	}
	lv := LenovoLookup(w)
	if lv.End != "2029-08-21" || lv.Level != "Premier Support 24x7x4" || lv.InWarranty == nil || *lv.InWarranty {
		t.Fatalf("lenovo: %+v", lv)
	}
}

func TestEmit(t *testing.T) {
	at := time.Date(2026, 11, 7, 8, 0, 0, 0, time.UTC)
	assets := []Asset{{SerialNumber: "FOC1", CiType: "network_device", Name: "ryd-dist-01"}, {SerialNumber: "GONE", CiType: "host", Name: "x"}}
	found := map[string]*Lookup{"FOC1": {SerialNumber: "FOC1", Provider: "Cisco", Level: "WARR-1YR-LTD-HW", End: "2027-01-01", SupportEnd: "2028-05-31", EndOfSale: "2025-01-31", EndOfSupport: "2030-01-31"}}
	obs := Emit(assets, found, [][]byte{[]byte("{}")}, at)
	if len(obs.Cis) != 1 || len(obs.Evidence) != 1 {
		t.Fatalf("observation: %+v", obs)
	}
	ci := obs.Cis[0]
	if ci.Type != "network_device" || ci.Identity["serialNumber"] != "FOC1" || ci.Name != "ryd-dist-01" {
		t.Fatalf("ci: %+v", ci)
	}
	a := ci.Attributes
	if a["warrantyEnd"] != "2027-01-01" || a["inWarranty"] != true || a["endOfSale"] != "2025-01-31" || a["eolSource"] != "vendor_api" || a["warrantyVerifiedAt"] != "2026-11-07T08:00:00Z" {
		t.Fatalf("attributes: %+v", a)
	}
	if _, ok := a["endOfSoftwareMaintenance"]; ok {
		t.Fatal("an absent milestone was emitted")
	}
}
