// T-403 REQ-DISC-026 — regression found by the simulated-mode SNMP power simulator (REQ-QA-005): a Vertiv
// Liebert UPS behind a Unity card answers RFC 1628 UPS-MIB and the LIEBERT-GP-AGENT-MIB agent identity under
// the Liebert enterprise sysObjectID. It must be a ups CI keyed by the agent's serial, not a cooling_unit.
package snmp

import (
	"testing"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

func TestLiebertUpsIsPowerNotCooling(t *testing.T) {
	w := &Walk{Target: contract.Target{Kind: "host", Value: "10.200.7.40"}, Scalars: map[string]any{
		oidSysName: "ryd-dh01-ups-a", oidSysDescr: "Liebert Unity card, Liebert EXL S1", oidSysObjectID: ".1.3.6.1.4.1.476.1.42",
		oidUpsIdentManufacturer: "Vertiv", oidUpsIdentModel: "Liebert EXL S1 800 kVA", oidUpsIdentSoftware: "7.1.3",
		oidUpsBatteryStatus: int64(upsBatteryNormal), oidUpsMinutesRemaining: int64(8), oidUpsChargeRemaining: int64(100), oidUpsOutputSource: int64(upsSourceNormal),
		oidLgpAgentIdentModel: "Liebert EXL S1 800 kVA", oidLgpAgentIdentSerial: "LEX7V2PUFPB",
	}, Tables: map[string][]Varbind{
		oidUpsOutputPercentLoad: {{OID: oidUpsOutputPercentLoad + ".1", Value: int64(44)}},
	}, At: time.Date(2026, 11, 7, 9, 0, 0, 0, time.UTC)}
	d := Parse(w)
	if d.Cooling != nil {
		t.Fatalf("a Liebert UPS must not parse as a cooling unit: %+v", d.Cooling)
	}
	ups := Emit(d, w.Target, []byte("{}"), w.At).Cis[0]
	if ups.Type != typeUps || ups.Identity["serialNumber"] != "LEX7V2PUFPB" || ups.Attributes["loadPercent"] != int64(44) || ups.Attributes["health"] != "healthy" {
		t.Fatalf("Liebert UPS CI wrong: %+v", ups)
	}
	// A Liebert CRAC answering environmental state stays a cooling unit even if it also answered a UPS object.
	w.Scalars[oidLgpEnvStateSystem] = int64(lgpStateOn)
	if Parse(w).Cooling == nil {
		t.Fatal("environmental state must keep a Liebert unit a cooling unit")
	}
}
