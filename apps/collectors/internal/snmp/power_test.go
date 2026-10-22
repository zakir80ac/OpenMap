// T-061 REQ-DISC-026 — UPS-MIB and APC rack PDU objects become ups/pdu CIs with battery, load and
// outlet facts; outlets become power_feed CIs the PDU contains.
package snmp

import (
	"testing"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

func TestUpsMib(t *testing.T) {
	w := &Walk{Target: contract.Target{Kind: "host", Value: "10.200.5.10"}, Scalars: map[string]any{
		oidSysName: "ups-ryd-a1", oidSysDescr: "Eaton 9PX", oidSysObjectID: ".1.3.6.1.4.1.534.1",
		oidUpsIdentManufacturer: "EATON", oidUpsIdentModel: "9PX 6000i", oidUpsIdentSoftware: "02.08.0019", oidUpsBatteryStatus: 2, oidUpsMinutesRemaining: 42, oidUpsChargeRemaining: 100, oidUpsOutputSource: 3,
	}, Tables: map[string][]Varbind{oidUpsOutputPercentLoad: {{OID: oidUpsOutputPercentLoad + ".1", Value: 37}}, oidEntPhysicalSerialNum: {{OID: oidEntPhysicalSerialNum + ".1", Value: "G123A45678"}}, oidEntPhysicalClass: {{OID: oidEntPhysicalClass + ".1", Value: 3}}}}
	d := Parse(w)
	if d.Power == nil || d.Power.Kind != typeUps || d.Power.LoadPercent != 37 || d.Power.BatteryStatus != "normal" || d.Power.OnBattery {
		t.Fatalf("ups facts wrong: %+v", d.Power)
	}
	obs := Emit(d, w.Target, nil, time.Now())
	if obs.Cis[0].Type != typeUps || obs.Cis[0].Identity["serialNumber"] != "G123A45678" || obs.Cis[0].Attributes["health"] != "healthy" || obs.Cis[0].Attributes["model"] != "9PX 6000i" {
		t.Fatalf("ups ci wrong: %+v", obs.Cis[0])
	}
}

func TestApcPdu(t *testing.T) {
	w := &Walk{Target: contract.Target{Kind: "host", Value: "10.200.5.20"}, Scalars: map[string]any{
		oidSysName: "pdu-ryd-r12-a", oidSysDescr: "APC Web/SNMP Management Card", oidSysObjectID: ".1.3.6.1.4.1.318.1.3.4.6",
		oidApcPduSerial: "5A2345T01234", oidApcPduModel: "AP8853", oidApcPduRatingAmps: 32, oidApcPduPowerWatts: 4120,
	}, Tables: map[string][]Varbind{
		oidApcPduLoadTenthAmps: {{OID: oidApcPduLoadTenthAmps + ".1", Value: 95}, {OID: oidApcPduLoadTenthAmps + ".2", Value: 88}},
		oidApcPduOutletName:    {{OID: oidApcPduOutletName + ".1", Value: "esx-ryd-01 PSU1"}, {OID: oidApcPduOutletName + ".2", Value: "esx-ryd-02 PSU1"}, {OID: oidApcPduOutletName + ".10", Value: "spare"}},
		oidApcPduOutletState:   {{OID: oidApcPduOutletState + ".1", Value: 1}, {OID: oidApcPduOutletState + ".2", Value: 1}, {OID: oidApcPduOutletState + ".10", Value: 2}},
		oidApcPduOutletWatts:   {{OID: oidApcPduOutletWatts + ".1", Value: 410}},
	}}
	d := Parse(w)
	if d.Power == nil || d.Power.Kind != typePdu || d.Serial != "5A2345T01234" || d.Power.LoadAmps != 18.3 || len(d.Power.Outlets) != 3 || d.Power.Outlets[2].Index != "10" {
		t.Fatalf("pdu facts wrong: %+v", d.Power)
	}
	obs := Emit(d, w.Target, nil, time.Now())
	if obs.Cis[0].Type != typePdu || obs.Cis[0].Attributes["outletCount"] != 3 || obs.Cis[0].Attributes["outputWatts"] != int64(4120) {
		t.Fatalf("pdu ci wrong: %+v", obs.Cis[0])
	}
	feeds := 0
	contains := 0
	for _, ci := range obs.Cis {
		if ci.Type == typePowerFeed {
			feeds++
			if ci.Identity["pduRef"] != "5A2345T01234" {
				t.Fatalf("feed identity wrong: %+v", ci.Identity)
			}
			if ci.Name == "spare" && ci.Attributes["on"] != false {
				t.Fatalf("spare outlet should be off: %+v", ci.Attributes)
			}
		}
	}
	for _, r := range obs.Relationships {
		if r.Type == relContains && r.To.Type == typePowerFeed {
			contains++
		}
	}
	if feeds != 3 || contains != 3 {
		t.Fatalf("expected 3 power feeds contained by the pdu, got %d/%d", feeds, contains)
	}
}

func TestSwitchHasNoPower(t *testing.T) {
	w := &Walk{Target: contract.Target{Kind: "host", Value: "10.200.5.1"}, Scalars: map[string]any{oidSysName: "sw", oidSysDescr: "switch"}, Tables: map[string][]Varbind{}}
	if Parse(w).Power != nil {
		t.Fatal("switch must not carry power facts")
	}
}
