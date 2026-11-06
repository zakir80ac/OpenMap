// T-196 REQ-CMDB-014 — Redfish part walk: processors, DIMMs (absent ones skipped), the drives of a storage
// subsystem, the chassis network adapters and power supplies become the host's `components`.
package redfish

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

func ref(path string) map[string]string { return map[string]string{"@odata.id": path} }

func members(paths ...string) map[string]any {
	out := []map[string]string{}
	for _, p := range paths {
		out = append(out, ref(p))
	}
	return map[string]any{"Members": out}
}

func TestRedfishComponents(t *testing.T) {
	const sys = "/redfish/v1/Systems/1"
	const ch = "/redfish/v1/Chassis/1"
	docs := map[string]any{
		"/redfish/v1":         map[string]any{"Vendor": "HPE", "Product": "iLO 6", "Systems": ref("/redfish/v1/Systems"), "Chassis": ref("/redfish/v1/Chassis")},
		"/redfish/v1/Systems": members(sys),
		"/redfish/v1/Chassis": members(ch),
		sys: map[string]any{"Id": "1", "SerialNumber": "CZ2D1X0ABC", "Processors": ref(sys + "/Processors"), "Memory": ref(sys + "/Memory"), "Storage": ref(sys + "/Storage"),
			"Links": map[string]any{"Chassis": []map[string]string{ref(ch)}}},
		sys + "/Processors":                members(sys + "/Processors/1"),
		sys + "/Processors/1":              map[string]any{"Id": "1", "Socket": "Proc 1", "Model": "AMD EPYC 9354", "Manufacturer": "AMD", "TotalCores": 32, "TotalThreads": 64, "MaxSpeedMHz": 3800},
		sys + "/Memory":                    members(sys+"/Memory/proc1dimm1", sys+"/Memory/proc1dimm2"),
		sys + "/Memory/proc1dimm1":         map[string]any{"Id": "proc1dimm1", "DeviceLocator": "PROC 1 DIMM 1", "CapacityMiB": 65536, "Manufacturer": "Hynix", "SerialNumber": "80AD0123", "PartNumber": "HMCG94AEBRA ", "MemoryDeviceType": "DDR5", "OperatingSpeedMhz": 4800},
		sys + "/Memory/proc1dimm2":         map[string]any{"Id": "proc1dimm2", "DeviceLocator": "PROC 1 DIMM 2", "CapacityMiB": 0, "Status": map[string]string{"State": "Absent"}},
		sys + "/Storage":                   members(sys + "/Storage/DE00A000"),
		sys + "/Storage/DE00A000":          map[string]any{"Id": "DE00A000", "Drives": []map[string]string{ref(sys + "/Storage/DE00A000/Drives/0")}},
		sys + "/Storage/DE00A000/Drives/0": map[string]any{"Id": "0", "Name": "Drive 1I:1:1", "Model": "MZ7L3960HCJR", "SerialNumber": "S6K0NA0T", "CapacityBytes": 960197124096.0, "MediaType": "SSD", "Protocol": "SATA", "Revision": "HPG1"},
		ch:                                 map[string]any{"@odata.id": ch, "Id": "1", "Power": ref(ch + "/Power"), "NetworkAdapters": ref(ch + "/NetworkAdapters")},
		ch + "/Power":                      map[string]any{"PowerSupplies": []map[string]any{{"Name": "HpeServerPowerSupply 1", "SerialNumber": "5XUWB0ABC", "PowerCapacityWatts": 1600}, {"Name": "HpeServerPowerSupply 2", "Status": map[string]string{"State": "Absent"}}}},
		ch + "/NetworkAdapters":            members(ch + "/NetworkAdapters/DC080000"),
		ch + "/NetworkAdapters/DC080000":   map[string]any{"Id": "DC080000", "Model": "BCM57414", "Manufacturer": "Broadcom", "SerialNumber": "N1234", "Controllers": []map[string]any{{"FirmwarePackageVersion": "222.1.68"}}},
	}
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		doc, ok := docs[r.URL.Path]
		if !ok {
			doc, ok = docs[r.URL.Path[:len(r.URL.Path)-1]]
		}
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		_ = json.NewEncoder(w).Encode(doc)
	}))
	defer srv.Close()
	inv, err := clientFor(t, srv, "u", "p").Walk(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	obs := Emit(inv, contract.Target{Kind: "host", Value: "ilo-01"}, time.Unix(0, 0))
	parts := obs.Cis[1].Components
	if len(parts) == 0 {
		t.Fatalf("no components: %#v", obs.Cis[1])
	}
	count := map[string]int{}
	for _, p := range parts {
		count[p.Kind]++
	}
	if count["cpu"] != 1 || count["memory"] != 1 || count["disk"] != 1 || count["nic"] != 1 || count["psu"] != 1 {
		t.Fatalf("counts: %v (%+v)", count, parts)
	}
	for _, p := range parts {
		switch p.Kind {
		case "memory":
			if p.CapacityBytes != 65536*bytesPerMiB || p.PartNumber != "HMCG94AEBRA" {
				t.Fatalf("dimm: %+v", p)
			}
		case "disk":
			if p.Slot != "Drive 1I:1:1" || p.Details["media"] != "ssd" || p.Firmware != "HPG1" {
				t.Fatalf("drive: %+v", p)
			}
		case "nic":
			if p.Firmware != "222.1.68" {
				t.Fatalf("adapter: %+v", p)
			}
		}
	}
}
