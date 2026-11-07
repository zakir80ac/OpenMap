// T-396 REQ-DISC-013 REQ-QA-005 — gaps the simulated UCS Manager exposed: the CIMC address of a blade comes in
// the mgmtIf extIp attribute (UCSM object model), and Collect pins a private CA (caCertPem) with verifyTls on.
package ucs

import (
	"context"
	"encoding/pem"
	"testing"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

func TestCimcFromExtIP(t *testing.T) {
	inv := &Inventory{
		System:  topSystem{Name: "UCS-RYD-01"},
		Chassis: []equipmentChassis{{Dn: "sys/chassis-1", ID: "1", Serial: "FOX1"}},
		Blades:  []computeUnit{{Dn: "sys/chassis-1/blade-1", ChassisID: "1", SlotID: "1", Serial: "FCH1", UUID: "1B4E28BA-2FA1-11D2-883F-B9A761BDE3FB"}},
		MgmtIfs: []mgmtIf{{Dn: "sys/chassis-1/blade-1/mgmt/if-1", ExtIP: "10.220.9.11", Mac: "00:25:B5:00:00:01", Subject: "blade"}},
	}
	obs := Emit(inv, contract.Target{Kind: "host", Value: "ucs"}, time.Now())
	found := false
	for _, c := range obs.Cis {
		if c.Type == typeBmc && c.Identity["managementIp"] == "10.220.9.11" && c.Name == "CIMC @ 10.220.9.11" {
			found = true
		}
	}
	if !found {
		t.Fatalf("CIMC from extIp missing: %+v", obs.Cis)
	}
}

func TestCollectPinsCACertificate(t *testing.T) {
	srv := server(t)
	defer srv.Close()
	caPem := string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: srv.Certificate().Raw}))
	cred := &contract.Credential{Type: "password", Fields: map[string]string{credUser: "admin", credPassword: "pw"}}
	target := contract.Target{Kind: "host", Value: srv.URL}
	obs, err := Collector{}.Collect(context.Background(), target, cred, map[string]any{optionVerify: true, optionCA: caPem})
	if err != nil {
		t.Fatalf("pinned CA rejected: %v", err)
	}
	if count(obs.Cis, typeHost) != 2 {
		t.Fatalf("unexpected walk through the pinned client: %+v", obs.Cis)
	}
	if _, err := (Collector{}).Collect(context.Background(), target, cred, map[string]any{optionVerify: true}); err == nil {
		t.Fatal("verifyTls without the CA must reject the test certificate")
	}
}
