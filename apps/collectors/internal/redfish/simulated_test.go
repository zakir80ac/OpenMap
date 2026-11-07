// T-395 REQ-DISC-012 REQ-QA-005 — gaps the simulated-mode BMCs exposed: the collector pins a private CA
// (caCertPem) with verifyTls on, keeps a short ComputerSystem.HostName out of the fqdn identity (DMTF: the
// host name without domain information) while a dotted one still counts, and gives each HPE iLO power supply
// its own component slot when the BMC names them all alike.
package redfish

import (
	"context"
	"encoding/json"
	"encoding/pem"
	"net/url"
	"strconv"
	"testing"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

func TestCollectPinsCACertificate(t *testing.T) {
	srv := testServer(t)
	defer srv.Close()
	u, _ := url.Parse(srv.URL)
	port, _ := strconv.Atoi(u.Port())
	caPem := string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: srv.Certificate().Raw}))
	cred := &contract.Credential{Type: "password", Fields: map[string]string{credUser: "root", credPassword: "calvin"}}
	target := contract.Target{Kind: "host", Value: u.Hostname()}
	obs, err := Collector{}.Collect(context.Background(), target, cred, map[string]any{optionPort: port, optionVerify: true, optionCA: caPem})
	if err != nil {
		t.Fatalf("pinned CA rejected: %v", err)
	}
	if len(obs.Cis) != 2 {
		t.Fatalf("expected bmc + host, got %d", len(obs.Cis))
	}
	if _, err := (Collector{}).Collect(context.Background(), target, cred, map[string]any{optionPort: port, optionVerify: true}); err == nil {
		t.Fatal("verifyTls without the CA must reject the test certificate")
	}
}

func TestHostNameIdentity(t *testing.T) {
	inv := &Inventory{Systems: []systemDoc{{ID: "1", SerialNumber: "CZ1", HostName: "esx-ryd-01"}, {ID: "2", SerialNumber: "CZ2", HostName: "ESX-RYD-02.Bank.Local"}}}
	obs := Emit(inv, contract.Target{Kind: "host", Value: "10.0.0.1"}, time.Now())
	short, dotted := obs.Cis[1], obs.Cis[2]
	if _, ok := short.Identity["fqdn"]; ok || short.Name != "esx-ryd-01" || short.Attributes["hostname"] != "esx-ryd-01" {
		t.Fatalf("short host name must not be an fqdn identity: %+v", short)
	}
	if dotted.Identity["fqdn"] != "esx-ryd-02.bank.local" {
		t.Fatalf("dotted host name is the fqdn identity: %+v", dotted.Identity)
	}
}

func TestIloPowerSuppliesKeepTheirSlots(t *testing.T) {
	power := map[string]any{"PowerControl": []map[string]any{{"PowerConsumedWatts": 410}}, "PowerSupplies": []map[string]any{
		{"MemberId": "0", "Name": "HpeServerPowerSupply", "SerialNumber": "5WBXK0A1", "Status": map[string]string{"State": "Enabled", "Health": "OK"}},
		{"MemberId": "1", "Name": "HpeServerPowerSupply", "SerialNumber": "5WBXK0A2", "Status": map[string]string{"State": "Enabled", "Health": "OK"}},
	}}
	var doc powerDoc
	raw, _ := json.Marshal(power)
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	inv := &Inventory{Chassis: []chassisDoc{{ODataID: "/redfish/v1/Chassis/1", ID: "1"}}, Power: map[string]powerDoc{"1": doc}, Parts: map[string]parts{}}
	sys := systemDoc{ID: "1"}
	sys.Links.Chassis = []odataRef{{ID: "/redfish/v1/Chassis/1"}}
	slots := map[string]bool{}
	for _, c := range Components(inv, sys) {
		if c.Kind == contract.ComponentPSU {
			slots[c.Slot] = true
		}
	}
	if len(slots) != 2 || !slots["HpeServerPowerSupply 0"] || !slots["HpeServerPowerSupply 1"] {
		t.Fatalf("each supply needs its own slot: %v", slots)
	}
}
