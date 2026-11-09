// REQ-DISC-026 — cooling equipment over SNMP: Liebert / Vertiv CRAC and CRAH units through the
// LIEBERT-GP-ENVIRONMENTAL-MIB (system, cooling, heating and humidity control states, measured and
// set-point temperature and humidity, cooling capacity) and any unit that publishes the standard
// ENTITY-SENSOR-MIB (RFC 3433) temperature and humidity sensors. A device answering these objects is
// emitted as a `cooling_unit` CI with its environmental readings so the DCIM room view can show
// supply and return conditions next to the racks it serves.
package snmp

import (
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

const (
	// LIEBERT-GP-AGENT-MIB / LIEBERT-GP-ENVIRONMENTAL-MIB (enterprise 476).
	oidLiebertEnterprise          = ".1.3.6.1.4.1.476"
	oidLgpAgentIdentModel         = ".1.3.6.1.4.1.476.1.42.2.1.2.0"
	oidLgpAgentIdentFirmware      = ".1.3.6.1.4.1.476.1.42.2.1.3.0"
	oidLgpAgentIdentSerial        = ".1.3.6.1.4.1.476.1.42.2.1.4.0"
	oidLgpEnvStateSystem          = ".1.3.6.1.4.1.476.1.42.3.4.3.1.0" // 1 on, 2 off, 3 standby
	oidLgpEnvStateCooling         = ".1.3.6.1.4.1.476.1.42.3.4.3.2.0" // 1 on, 2 off
	oidLgpEnvStateHeating         = ".1.3.6.1.4.1.476.1.42.3.4.3.3.0"
	oidLgpEnvStateHumidifying     = ".1.3.6.1.4.1.476.1.42.3.4.3.4.0"
	oidLgpEnvStateDehumidifying   = ".1.3.6.1.4.1.476.1.42.3.4.3.5.0"
	oidLgpEnvStateCoolingCapacity = ".1.3.6.1.4.1.476.1.42.3.4.3.9.0"     // percent of rated capacity
	oidLgpEnvTemperatureDegC      = ".1.3.6.1.4.1.476.1.42.3.4.1.2.3.1.3" // table, measured, per sensor
	oidLgpEnvTemperatureSetDegC   = ".1.3.6.1.4.1.476.1.42.3.4.1.2.3.1.2" // table, set point
	oidLgpEnvHumidityRel          = ".1.3.6.1.4.1.476.1.42.3.4.2.2.3.1.3" // table, measured %RH
	oidLgpEnvHumiditySetRel       = ".1.3.6.1.4.1.476.1.42.3.4.2.2.3.1.2" // table, set point %RH
	// ENTITY-SENSOR-MIB (RFC 3433), indexed by entPhysicalIndex.
	oidEntPhySensorType      = ".1.3.6.1.2.1.99.1.1.1.1"
	oidEntPhySensorScale     = ".1.3.6.1.2.1.99.1.1.1.2"
	oidEntPhySensorPrecision = ".1.3.6.1.2.1.99.1.1.1.3"
	oidEntPhySensorValue     = ".1.3.6.1.2.1.99.1.1.1.4"
	oidEntPhySensorStatus    = ".1.3.6.1.2.1.99.1.1.1.5"

	lgpStateOn      = 1
	lgpStateOff     = 2
	lgpStateStandby = 3

	entSensorCelsius   = 8
	entSensorPercentRH = 9
	entSensorStatusOk  = 1
	// entPhySensorScale enumerations: 9 is units (10^0); each step is a factor of 10^3.
	entScaleUnits      = 9
	entScaleStepPowers = 3

	typeCoolingUnit = "cooling_unit"
)

var coolingScalarOIDs = []string{
	oidLgpAgentIdentModel, oidLgpAgentIdentFirmware, oidLgpAgentIdentSerial,
	oidLgpEnvStateSystem, oidLgpEnvStateCooling, oidLgpEnvStateHeating, oidLgpEnvStateHumidifying, oidLgpEnvStateDehumidifying, oidLgpEnvStateCoolingCapacity,
}

// coolingStateOIDs are the environmental control states only a cooling unit publishes.
var coolingStateOIDs = []string{oidLgpEnvStateSystem, oidLgpEnvStateCooling, oidLgpEnvStateHeating, oidLgpEnvStateHumidifying, oidLgpEnvStateDehumidifying, oidLgpEnvStateCoolingCapacity}

var coolingTableOIDs = []string{
	oidLgpEnvTemperatureDegC, oidLgpEnvTemperatureSetDegC, oidLgpEnvHumidityRel, oidLgpEnvHumiditySetRel,
	oidEntPhySensorType, oidEntPhySensorScale, oidEntPhySensorPrecision, oidEntPhySensorValue, oidEntPhySensorStatus,
}

// Sensor is one environmental reading with the unit it was published in.
type Sensor struct {
	Index string
	Name  string
	Kind  string // temperature_c | humidity_rh
	Value float64
	Ok    bool
}

// CoolingFacts is what the cooling MIBs reported.
type CoolingFacts struct {
	Model           string
	Serial          string
	Firmware        string
	SystemState     string // on | off | standby | unknown
	Cooling         *bool
	Heating         *bool
	Humidifying     *bool
	Dehumidifying   *bool
	CapacityPercent int64
	// CapacityMetered is true when the unit reported its cooling capacity in use.
	CapacityMetered bool
	TemperatureC    []float64
	TemperatureSetC []float64
	HumidityRH      []float64
	HumiditySetRH   []float64
	Sensors         []Sensor
}

func lgpState(v any) *bool {
	n, ok := asInt(v)
	if !ok {
		return nil
	}
	on := n == lgpStateOn
	return &on
}

func systemStateName(v any) string {
	n, ok := asInt(v)
	if !ok {
		return ""
	}
	switch n {
	case lgpStateOn:
		return "on"
	case lgpStateOff:
		return "off"
	case lgpStateStandby:
		return "standby"
	default:
		return "unknown"
	}
}

func columnFloats(w *Walk, prefix string) []float64 {
	col := w.column(prefix)
	indexes := make([]string, 0, len(col))
	for idx := range col {
		indexes = append(indexes, idx)
	}
	sortNumeric(indexes)
	out := make([]float64, 0, len(indexes))
	for _, idx := range indexes {
		if n, ok := asInt(col[idx]); ok {
			out = append(out, float64(n))
		}
	}
	return out
}

// entitySensors decodes ENTITY-SENSOR-MIB rows into Celsius and %RH readings; other sensor types are
// not environmental and are skipped. Names come from the ENTITY-MIB entPhysicalName column when present.
func entitySensors(w *Walk, names map[string]any) []Sensor {
	types := w.column(oidEntPhySensorType)
	scales := w.column(oidEntPhySensorScale)
	precisions := w.column(oidEntPhySensorPrecision)
	values := w.column(oidEntPhySensorValue)
	statuses := w.column(oidEntPhySensorStatus)
	indexes := make([]string, 0, len(types))
	for idx := range types {
		indexes = append(indexes, idx)
	}
	sortNumeric(indexes)
	out := []Sensor{}
	for _, idx := range indexes {
		kind, ok := asInt(types[idx])
		if !ok {
			continue
		}
		var label string
		switch kind {
		case entSensorCelsius:
			label = "temperature_c"
		case entSensorPercentRH:
			label = "humidity_rh"
		default:
			continue
		}
		raw, ok := asInt(values[idx])
		if !ok {
			continue
		}
		value := float64(raw)
		if scale, ok := asInt(scales[idx]); ok {
			value *= math.Pow10(int(scale-entScaleUnits) * entScaleStepPowers)
		}
		if precision, ok := asInt(precisions[idx]); ok && precision > 0 {
			value /= math.Pow10(int(precision))
		}
		status, _ := asInt(statuses[idx])
		out = append(out, Sensor{Index: idx, Name: asString(names[idx]), Kind: label, Value: value, Ok: status == entSensorStatusOk || statuses[idx] == nil})
	}
	return out
}

// parseCooling reads the cooling objects; nil when the device exposes none of them.
func parseCooling(w *Walk, sysObjectID string) *CoolingFacts {
	// Every Liebert card publishes the agent identity under the Liebert enterprise sysObjectID, a UPS behind
	// a Unity card included (REQ-DISC-026, T-403): without environmental state, a device that answers a
	// UPS or PDU MIB is power equipment, not a cooling unit.
	envState := false
	for _, oid := range coolingStateOIDs {
		envState = envState || w.Scalars[oid] != nil
	}
	if !envState && parsePower(w) != nil {
		return nil
	}
	c := &CoolingFacts{}
	liebert := w.scalarString(oidLgpAgentIdentSerial) != "" || w.scalarString(oidLgpAgentIdentModel) != "" || w.Scalars[oidLgpEnvStateSystem] != nil
	if liebert {
		c.Model = w.scalarString(oidLgpAgentIdentModel)
		c.Serial = w.scalarString(oidLgpAgentIdentSerial)
		c.Firmware = w.scalarString(oidLgpAgentIdentFirmware)
		c.SystemState = systemStateName(w.Scalars[oidLgpEnvStateSystem])
		c.Cooling = lgpState(w.Scalars[oidLgpEnvStateCooling])
		c.Heating = lgpState(w.Scalars[oidLgpEnvStateHeating])
		c.Humidifying = lgpState(w.Scalars[oidLgpEnvStateHumidifying])
		c.Dehumidifying = lgpState(w.Scalars[oidLgpEnvStateDehumidifying])
		c.CapacityPercent, c.CapacityMetered = asInt(w.Scalars[oidLgpEnvStateCoolingCapacity])
		c.TemperatureC = columnFloats(w, oidLgpEnvTemperatureDegC)
		c.TemperatureSetC = columnFloats(w, oidLgpEnvTemperatureSetDegC)
		c.HumidityRH = columnFloats(w, oidLgpEnvHumidityRel)
		c.HumiditySetRH = columnFloats(w, oidLgpEnvHumiditySetRel)
	}
	c.Sensors = entitySensors(w, w.column(oidEntPhysicalName))
	// Standard sensors alone do not make a device a cooling unit (switches publish them too): the vendor
	// objects or a Liebert enterprise sysObjectID do.
	if !liebert && !hasPrefix(sysObjectID, oidLiebertEnterprise) {
		return nil
	}
	return c
}

func hasPrefix(oid, prefix string) bool {
	return len(oid) >= len(prefix) && oid[:len(prefix)] == prefix && (len(oid) == len(prefix) || oid[len(prefix)] == '.')
}

func boolAttr(attrs map[string]any, key string, v *bool) {
	if v != nil {
		attrs[key] = *v
	}
}

// coolingAttributes merges the cooling facts into the device attributes.
func coolingAttributes(c *CoolingFacts, attrs map[string]any) {
	attrs["coolingSystemState"] = c.SystemState
	boolAttr(attrs, "coolingActive", c.Cooling)
	boolAttr(attrs, "heatingActive", c.Heating)
	boolAttr(attrs, "humidifyingActive", c.Humidifying)
	boolAttr(attrs, "dehumidifyingActive", c.Dehumidifying)
	attrs["coolingCapacityPercent"] = c.CapacityPercent
	if len(c.TemperatureC) > 0 {
		attrs["temperatureC"] = c.TemperatureC
	}
	if len(c.TemperatureSetC) > 0 {
		attrs["temperatureSetPointC"] = c.TemperatureSetC
	}
	if len(c.HumidityRH) > 0 {
		attrs["humidityPercent"] = c.HumidityRH
	}
	if len(c.HumiditySetRH) > 0 {
		attrs["humiditySetPointPercent"] = c.HumiditySetRH
	}
	if len(c.Sensors) > 0 {
		sensors := make([]map[string]any, 0, len(c.Sensors))
		for _, s := range c.Sensors {
			sensors = append(sensors, map[string]any{"index": s.Index, "name": s.Name, "kind": s.Kind, "value": s.Value, "ok": s.Ok})
		}
		attrs["sensors"] = sensors
	}
	switch {
	case c.SystemState == "off":
		attrs["health"] = "down"
	case c.SystemState == "standby":
		attrs["health"] = "degraded"
	case c.SystemState == "on":
		attrs["health"] = "healthy"
	}
	attrs["sensorCount"] = len(c.Sensors)
}

// sensorPosition is where a probe's name says it sits, the way vendors name them ("Rack Inlet 1", "Supply Air",
// "Return Air Temp", "Exhaust"); empty when the name says nothing. It mirrors sensorPosition in
// packages/contracts/src/environment.ts (REQ-DCIM-006).
func sensorPosition(name string) string {
	n := strings.ToLower(name)
	switch {
	case containsAny(n, "inlet", "intake", "front"):
		return "inlet"
	case containsAny(n, "outlet", "exhaust", "rear", "back"):
		return "outlet"
	case containsAny(n, "supply", "discharge"):
		return "supply"
	case containsAny(n, "return"):
		return "return"
	case containsAny(n, "room", "ambient"):
		return "room"
	}
	return ""
}

func containsAny(s string, words ...string) bool {
	for _, w := range words {
		if strings.Contains(s, w) {
			return true
		}
	}
	return false
}

// coolingSamples are the unit's readings as samples (REQ-DCIM-006): every temperature and humidity it measured,
// with the sensor and, when its name says, its position, and the cooling capacity in use.
func coolingSamples(c *CoolingFacts, ref contract.CiRef, at time.Time) []contract.MetricSample {
	out := []contract.MetricSample{}
	add := func(metric, unit string, value float64, labels map[string]string) {
		out = append(out, contract.MetricSample{Ci: ref, Metric: metric, Ts: at, Value: value, Unit: unit, Labels: labels})
	}
	for i, v := range c.TemperatureC {
		add(contract.MetricEnvTemperature, contract.UnitCelsius, v, map[string]string{"sensor": strconv.Itoa(i + 1)})
	}
	for i, v := range c.HumidityRH {
		add(contract.MetricEnvHumidity, contract.UnitPercent, v, map[string]string{"sensor": strconv.Itoa(i + 1)})
	}
	for _, s := range c.Sensors {
		if !s.Ok {
			continue
		}
		labels := map[string]string{"sensor": firstNonEmpty(s.Name, s.Index)}
		if pos := sensorPosition(s.Name); pos != "" {
			labels["position"] = pos
		}
		switch s.Kind {
		case "temperature_c":
			add(contract.MetricEnvTemperature, contract.UnitCelsius, s.Value, labels)
		case "humidity_rh":
			add(contract.MetricEnvHumidity, contract.UnitPercent, s.Value, labels)
		}
	}
	if c.CapacityMetered {
		add(contract.MetricCoolingCapacity, contract.UnitPercent, float64(c.CapacityPercent), map[string]string{})
	}
	return out
}
