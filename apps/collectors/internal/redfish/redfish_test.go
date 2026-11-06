// T-033 REQ-DISC-012 — walks a Redfish service served by httptest with DMTF-shaped documents and
// checks the emitted host and bmc observations. Vendor recordings live under packages/testing/fixtures/vendor/ipmi_redfish.
package redfish

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

func testServer(t *testing.T) *httptest.Server {
	t.Helper()
	docs := map[string]any{
		"/redfish/v1/": map[string]any{"RedfishVersion": "1.15.0", "Vendor": "Dell", "Product": "Integrated Dell Remote Access Controller",
			"Systems": map[string]string{"@odata.id": "/redfish/v1/Systems"}, "Chassis": map[string]string{"@odata.id": "/redfish/v1/Chassis"}, "Managers": map[string]string{"@odata.id": "/redfish/v1/Managers"}},
		"/redfish/v1/Systems":  map[string]any{"Members": []map[string]string{{"@odata.id": "/redfish/v1/Systems/System.Embedded.1"}}},
		"/redfish/v1/Chassis":  map[string]any{"Members": []map[string]string{{"@odata.id": "/redfish/v1/Chassis/System.Embedded.1"}}},
		"/redfish/v1/Managers": map[string]any{"Members": []map[string]string{{"@odata.id": "/redfish/v1/Managers/iDRAC.Embedded.1"}}},
		"/redfish/v1/Systems/System.Embedded.1": map[string]any{"Id": "System.Embedded.1", "Name": "System", "Manufacturer": "Dell Inc.", "Model": "PowerEdge R760", "SerialNumber": "7KQ2M93", "UUID": "4C4C4544-004B-5110-8032-B4C04F4D3933",
			"HostName": "db-ryd-pg-core-01", "PowerState": "On", "BiosVersion": "2.4.1", "Status": map[string]string{"State": "Enabled", "Health": "OK"},
			"ProcessorSummary": map[string]any{"Count": 2, "Model": "Intel(R) Xeon(R) Gold 6448Y"}, "MemorySummary": map[string]any{"TotalSystemMemoryGiB": 512},
			"EthernetInterfaces": map[string]string{"@odata.id": "/redfish/v1/Systems/System.Embedded.1/EthernetInterfaces"}},
		"/redfish/v1/Systems/System.Embedded.1/EthernetInterfaces":                      map[string]any{"Members": []map[string]string{{"@odata.id": "/redfish/v1/Systems/System.Embedded.1/EthernetInterfaces/NIC.Integrated.1-1-1"}}},
		"/redfish/v1/Systems/System.Embedded.1/EthernetInterfaces/NIC.Integrated.1-1-1": map[string]any{"Id": "NIC.Integrated.1-1-1", "MACAddress": "B4:96:91:AA:BB:01", "LinkStatus": "LinkUp", "SpeedMbps": 25000, "IPv4Addresses": []map[string]string{{"Address": "10.20.4.18"}}},
		"/redfish/v1/Chassis/System.Embedded.1": map[string]any{"Id": "System.Embedded.1", "ChassisType": "RackMount", "Manufacturer": "Dell Inc.", "Model": "PowerEdge R760", "SerialNumber": "7KQ2M93",
			"Location": map[string]any{"Placement": map[string]any{"Rack": "R12", "RackOffset": 18, "Row": "C"}},
			"Power":    map[string]string{"@odata.id": "/redfish/v1/Chassis/System.Embedded.1/Power"}, "Thermal": map[string]string{"@odata.id": "/redfish/v1/Chassis/System.Embedded.1/Thermal"}},
		"/redfish/v1/Chassis/System.Embedded.1/Power": map[string]any{"PowerControl": []map[string]any{{"PowerConsumedWatts": 612, "PowerCapacityWatts": 1400}},
			"PowerSupplies": []map[string]any{{"Name": "PS1", "Status": map[string]string{"Health": "OK"}}, {"Name": "PS2", "Status": map[string]string{"Health": "Critical"}}}},
		"/redfish/v1/Chassis/System.Embedded.1/Thermal": map[string]any{"Temperatures": []map[string]any{{"Name": "System Board Inlet Temp", "ReadingCelsius": 23.5, "PhysicalContext": "Intake"}, {"Name": "System Board Exhaust Temp", "ReadingCelsius": 38.1, "PhysicalContext": "Exhaust"}}},
		"/redfish/v1/Managers/iDRAC.Embedded.1":         map[string]any{"Id": "iDRAC.Embedded.1", "ManagerType": "BMC", "Model": "iDRAC9", "FirmwareVersion": "7.10.30.00", "UUID": "3234-3835-..."},
	}
	return httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		u, p, ok := r.BasicAuth()
		if !ok || u != "root" || p != "calvin" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		doc, found := docs[strings.TrimSuffix(r.URL.Path, "/")]
		if !found {
			doc, found = docs[r.URL.Path]
		}
		if !found {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(doc)
	}))
}

func clientFor(t *testing.T, srv *httptest.Server, user, pass string) *Client {
	t.Helper()
	u, _ := url.Parse(srv.URL)
	port, _ := strconv.Atoi(u.Port())
	return NewClient(u.Hostname(), port, user, pass, false)
}

func TestWalkAndEmit(t *testing.T) {
	srv := testServer(t)
	defer srv.Close()
	c := clientFor(t, srv, "root", "calvin")
	inv, err := c.Walk(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	obs := Emit(inv, contract.Target{Kind: "host", Value: "10.200.1.20"}, time.Now())
	if len(obs.Cis) != 2 {
		t.Fatalf("expected bmc + host, got %d", len(obs.Cis))
	}
	host := obs.Cis[1]
	if host.Type != typeHost || host.Identity["serialNumber"] != "7KQ2M93" || host.Identity["primaryMac"] != "b4:96:91:aa:bb:01" || host.Identity["fqdn"] != "db-ryd-pg-core-01" {
		t.Fatalf("host identity wrong: %+v", host.Identity)
	}
	if host.Attributes["powerWatts"] != 612.0 || host.Attributes["powerSuppliesHealthy"] != 1 || host.Attributes["inletTempC"] != 23.5 || host.Attributes["rack"] != "R12" {
		t.Fatalf("host attributes wrong: %+v", host.Attributes)
	}
	// T-203 REQ-CMDB-034: power drawn is sampled for the utilisation register.
	if len(obs.Samples) != 1 || obs.Samples[0].Metric != contract.MetricHostPower || obs.Samples[0].Value != 612 || obs.Samples[0].Unit != contract.UnitWatts {
		t.Fatalf("power sample wrong: %+v", obs.Samples)
	}
	bmc := obs.Cis[0]
	if bmc.Type != typeBmc || bmc.Attributes["model"] != "iDRAC9" || bmc.Attributes["firmware"] != "7.10.30.00" {
		t.Fatalf("bmc wrong: %+v", bmc)
	}
	if len(obs.Relationships) != 2 || obs.Relationships[0].Type != relManages {
		t.Fatalf("relationships wrong: %+v", obs.Relationships)
	}
	if len(obs.Evidence) < 5 {
		t.Fatalf("expected evidence per document, got %d", len(obs.Evidence))
	}
}

func TestAuthFailureIsNotRetryable(t *testing.T) {
	srv := testServer(t)
	defer srv.Close()
	c := clientFor(t, srv, "root", "wrong")
	_, err := c.Walk(context.Background())
	te, ok := err.(interface{ Error() string })
	if !ok || !strings.Contains(te.Error(), contract.ErrAuthFailed) {
		t.Fatalf("expected auth failure, got %v", err)
	}
}
