// T-439 REQ-QA-005 REQ-DISC-018 — regression found by the simulated Thunder: the appliance identity's
// managementIp is the management port address from /interface/management, and without it the target's
// host, never the raw target (a URL with scheme and port would never merge with the SNMP-discovered CI).
package a10

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

func TestManagementAddressKeysTheAppliance(t *testing.T) {
	inv := &Inventory{}
	if err := json.Unmarshal([]byte(`{"management":{"ip":{"ipv4-address":"10.32.0.250","ipv4-netmask":"255.255.255.0","dhcp":0},"action":"enable"}}`), &inv.Management); err != nil {
		t.Fatal(err)
	}
	inv.Version.Version.Oper.Hostname = "dmm-a10-01"
	inv.Version.Version.Oper.SerialNumber = "TH30A0000001"
	obs := Emit(inv, contract.Target{Kind: "host", Value: "https://127.0.0.1:8443"}, time.Now())
	if got := obs.Cis[0].Identity["managementIp"]; got != "10.32.0.250" {
		t.Fatalf("managementIp %q, want the management port address", got)
	}
	cases := map[string]string{
		"https://127.0.0.1:8443": "127.0.0.1",
		"10.32.0.9:443":          "10.32.0.9",
		"thunder.bank.local":     "thunder.bank.local",
		"10.32.0.9":              "10.32.0.9",
	}
	for target, want := range cases {
		if got := ManagementAddress(&Inventory{}, target); got != want {
			t.Errorf("ManagementAddress(%q) = %q, want %q", target, got, want)
		}
	}
}
