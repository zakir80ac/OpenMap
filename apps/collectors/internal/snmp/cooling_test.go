// T-068 REQ-DISC-026 — a Liebert CRAC walk (agent identity, environmental states, temperature and humidity
// tables, standard ENTITY-SENSOR rows) becomes a cooling_unit CI with readings and health; a switch publishing
// ENTITY-SENSOR temperatures alone stays a network device.
package snmp

import (
	"testing"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

func TestLiebertCrac(t *testing.T) {
	w := &Walk{Target: contract.Target{Kind: "host", Value: "10.200.7.30"}, Scalars: map[string]any{
		oidSysName: "crac-ryd-a1", oidSysDescr: "Liebert Intellislot Unity", oidSysObjectID: ".1.3.6.1.4.1.476.1.42",
		oidLgpAgentIdentModel: "PEX S 20kW", oidLgpAgentIdentFirmware: "7.2.1.0", oidLgpAgentIdentSerial: "N19K70012345",
		oidLgpEnvStateSystem: int64(1), oidLgpEnvStateCooling: int64(1), oidLgpEnvStateHeating: int64(2), oidLgpEnvStateHumidifying: int64(2), oidLgpEnvStateDehumidifying: int64(1), oidLgpEnvStateCoolingCapacity: int64(63),
	}, Tables: map[string][]Varbind{
		oidLgpEnvTemperatureDegC:    {{OID: oidLgpEnvTemperatureDegC + ".1", Value: int64(21)}, {OID: oidLgpEnvTemperatureDegC + ".2", Value: int64(34)}},
		oidLgpEnvTemperatureSetDegC: {{OID: oidLgpEnvTemperatureSetDegC + ".1", Value: int64(22)}},
		oidLgpEnvHumidityRel:        {{OID: oidLgpEnvHumidityRel + ".1", Value: int64(44)}},
		oidLgpEnvHumiditySetRel:     {{OID: oidLgpEnvHumiditySetRel + ".1", Value: int64(45)}},
		oidEntPhysicalName:          {{OID: oidEntPhysicalName + ".3", Value: "Supply air"}, {OID: oidEntPhysicalName + ".4", Value: "Return humidity"}},
		oidEntPhySensorType:         {{OID: oidEntPhySensorType + ".3", Value: int64(entSensorCelsius)}, {OID: oidEntPhySensorType + ".4", Value: int64(entSensorPercentRH)}, {OID: oidEntPhySensorType + ".5", Value: int64(6)}},
		oidEntPhySensorScale:        {{OID: oidEntPhySensorScale + ".3", Value: int64(entScaleUnits)}, {OID: oidEntPhySensorScale + ".4", Value: int64(entScaleUnits)}},
		oidEntPhySensorPrecision:    {{OID: oidEntPhySensorPrecision + ".3", Value: int64(1)}, {OID: oidEntPhySensorPrecision + ".4", Value: int64(0)}},
		oidEntPhySensorValue:        {{OID: oidEntPhySensorValue + ".3", Value: int64(212)}, {OID: oidEntPhySensorValue + ".4", Value: int64(44)}, {OID: oidEntPhySensorValue + ".5", Value: int64(900)}},
		oidEntPhySensorStatus:       {{OID: oidEntPhySensorStatus + ".3", Value: int64(entSensorStatusOk)}, {OID: oidEntPhySensorStatus + ".4", Value: int64(entSensorStatusOk)}},
	}, At: time.Date(2026, 10, 22, 9, 0, 0, 0, time.UTC)}
	d := Parse(w)
	if d.Cooling == nil {
		t.Fatal("expected cooling facts")
	}
	c := d.Cooling
	if c.Serial != "N19K70012345" || c.SystemState != "on" || c.Cooling == nil || !*c.Cooling || c.Heating == nil || *c.Heating || c.CapacityPercent != 63 {
		t.Fatalf("cooling facts wrong: %+v", c)
	}
	if len(c.TemperatureC) != 2 || c.TemperatureC[1] != 34 || len(c.HumidityRH) != 1 || c.HumiditySetRH[0] != 45 {
		t.Fatalf("readings wrong: %+v", c)
	}
	if len(c.Sensors) != 2 || c.Sensors[0].Kind != "temperature_c" || c.Sensors[0].Value != 21.2 || c.Sensors[0].Name != "Supply air" || c.Sensors[1].Kind != "humidity_rh" || c.Sensors[1].Value != 44 {
		t.Fatalf("entity sensors wrong: %+v", c.Sensors)
	}
	obs := Emit(d, w.Target, []byte("{}"), w.At)
	unit := obs.Cis[0]
	if unit.Type != typeCoolingUnit || unit.Identity["serialNumber"] != "N19K70012345" || unit.Attributes["health"] != "healthy" || unit.Attributes["model"] != "PEX S 20kW" || unit.Attributes["coolingCapacityPercent"] != int64(63) {
		t.Fatalf("cooling unit CI wrong: %+v", unit)
	}
}

func TestSwitchWithSensorsIsNotCooling(t *testing.T) {
	w := &Walk{Target: contract.Target{Kind: "host", Value: "10.200.7.1"}, Scalars: map[string]any{oidSysName: "sw-a1", oidSysDescr: "switch", oidSysObjectID: ".1.3.6.1.4.1.9.1.2494"}, Tables: map[string][]Varbind{
		oidEntPhySensorType:  {{OID: oidEntPhySensorType + ".1", Value: int64(entSensorCelsius)}},
		oidEntPhySensorValue: {{OID: oidEntPhySensorValue + ".1", Value: int64(41)}},
	}}
	if parseCooling(w, ".1.3.6.1.4.1.9.1.2494") != nil {
		t.Fatal("a switch with temperature sensors must not become a cooling unit")
	}
	if c := parseCooling(w, ".1.3.6.1.4.1.476.1.42.99"); c == nil || len(c.Sensors) != 1 || c.Sensors[0].Value != 41 {
		t.Fatalf("a Liebert sysObjectID with standard sensors only must still parse: %+v", c)
	}
	if c := parseCooling(&Walk{Scalars: map[string]any{oidLgpEnvStateSystem: int64(2)}, Tables: map[string][]Varbind{}}, ""); c == nil || c.SystemState != "off" {
		t.Fatalf("off state wrong: %+v", c)
	}
}
