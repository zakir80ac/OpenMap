// REQ-DISC-026 — power equipment over SNMP: RFC 1628 UPS-MIB (every standards-compliant UPS: Eaton,
// Vertiv, Schneider), APC PowerNet (Smart-UPS, rack PDUs) and Raritan PX PDUs. A device answering
// these objects is emitted as a `ups` or `pdu` CI instead of a network device, with battery, load
// and per-outlet facts, and each outlet becomes a power_feed the DCIM racks can cable to.
package snmp

import (
	"strings"
)

const (
	// UPS-MIB (RFC 1628)
	oidUpsIdentManufacturer = ".1.3.6.1.2.1.33.1.1.1.0"
	oidUpsIdentModel        = ".1.3.6.1.2.1.33.1.1.2.0"
	oidUpsIdentSoftware     = ".1.3.6.1.2.1.33.1.1.3.0"
	oidUpsIdentName         = ".1.3.6.1.2.1.33.1.1.5.0"
	oidUpsBatteryStatus     = ".1.3.6.1.2.1.33.1.2.1.0"
	oidUpsMinutesRemaining  = ".1.3.6.1.2.1.33.1.2.3.0"
	oidUpsChargeRemaining   = ".1.3.6.1.2.1.33.1.2.4.0"
	oidUpsInputLineBads     = ".1.3.6.1.2.1.33.1.3.1.0"
	oidUpsOutputSource      = ".1.3.6.1.2.1.33.1.4.1.0"
	oidUpsOutputPercentLoad = ".1.3.6.1.2.1.33.1.4.4.1.5" // table, per output line
	oidUpsOutputPower       = ".1.3.6.1.2.1.33.1.4.4.1.4" // table, watts
	// APC PowerNet-MIB
	oidApcUpsSerial        = ".1.3.6.1.4.1.318.1.1.1.1.2.3.0"
	oidApcUpsModel         = ".1.3.6.1.4.1.318.1.1.1.1.1.1.0"
	oidApcUpsBatteryStatus = ".1.3.6.1.4.1.318.1.1.1.2.1.1.0"
	oidApcUpsOutputLoad    = ".1.3.6.1.4.1.318.1.1.1.4.2.3.0"
	oidApcPduModel         = ".1.3.6.1.4.1.318.1.1.12.1.5.0"
	oidApcPduSerial        = ".1.3.6.1.4.1.318.1.1.12.1.6.0"
	oidApcPduRatingAmps    = ".1.3.6.1.4.1.318.1.1.12.1.7.0"
	oidApcPduPowerWatts    = ".1.3.6.1.4.1.318.1.1.12.1.16.0"
	oidApcPduLoadTenthAmps = ".1.3.6.1.4.1.318.1.1.12.2.3.1.1.2" // table, per phase/bank
	oidApcPduOutletName    = ".1.3.6.1.4.1.318.1.1.12.3.5.1.1.2"
	oidApcPduOutletState   = ".1.3.6.1.4.1.318.1.1.12.3.5.1.1.4" // 1 on, 2 off
	oidApcPduOutletWatts   = ".1.3.6.1.4.1.318.1.1.26.9.4.3.1.7" // rPDU2OutletMeteredStatusPower
	// Raritan PDU2-MIB (PX2/PX3)
	oidRaritanModel       = ".1.3.6.1.4.1.13742.6.3.2.1.1.3.1"
	oidRaritanSerial      = ".1.3.6.1.4.1.13742.6.3.2.1.1.4.1"
	oidRaritanOutletName  = ".1.3.6.1.4.1.13742.6.3.5.3.1.3.1"     // table, per outlet
	oidRaritanOutletState = ".1.3.6.1.4.1.13742.6.5.4.3.1.3.1"     // outletSwitchingState table (14)? see outlet sensors
	oidRaritanInletPower  = ".1.3.6.1.4.1.13742.6.5.2.3.1.4.1.1.5" // inlet active power (W)

	upsBatteryNormal   = 2
	upsBatteryLow      = 3
	upsBatteryDepleted = 4
	upsSourceNormal    = 3
	upsSourceBattery   = 5
	apcOutletOn        = 1
	tenths             = 10.0

	typePdu       = "pdu"
	typeUps       = "ups"
	typePowerFeed = "power_feed"
)

var powerScalarOIDs = []string{
	oidUpsIdentManufacturer, oidUpsIdentModel, oidUpsIdentSoftware, oidUpsIdentName, oidUpsBatteryStatus, oidUpsMinutesRemaining, oidUpsChargeRemaining, oidUpsInputLineBads, oidUpsOutputSource,
	oidApcUpsSerial, oidApcUpsModel, oidApcUpsBatteryStatus, oidApcUpsOutputLoad,
	oidApcPduModel, oidApcPduSerial, oidApcPduRatingAmps, oidApcPduPowerWatts,
	oidRaritanModel, oidRaritanSerial, oidRaritanInletPower,
}

var powerTableOIDs = []string{oidUpsOutputPercentLoad, oidUpsOutputPower, oidApcPduLoadTenthAmps, oidApcPduOutletName, oidApcPduOutletState, oidApcPduOutletWatts, oidRaritanOutletName}

// Outlet is one switched or metered outlet of a PDU.
type Outlet struct {
	Index string
	Name  string
	On    *bool
	Watts int64
	// Metered is true when the PDU reported the outlet's draw (a 0 W reading is metered; an unreported one is not).
	Metered bool
}

// PowerFacts is what the power MIBs reported.
type PowerFacts struct {
	Kind             string // ups | pdu
	Manufacturer     string
	Model            string
	Serial           string
	Firmware         string
	BatteryStatus    string
	MinutesRemaining int64
	ChargePercent    int64
	OnBattery        bool
	LoadPercent      int64
	LoadAmps         float64
	RatingAmps       int64
	OutputWatts      int64
	// OutputMetered is true when the PDU or UPS reported its total draw.
	OutputMetered bool
	InputLineBads int64
	Outlets       []Outlet
}

func batteryStatusName(v int64) string {
	switch v {
	case upsBatteryNormal:
		return "normal"
	case upsBatteryLow:
		return "low"
	case upsBatteryDepleted:
		return "depleted"
	default:
		return "unknown"
	}
}

// parsePower reads UPS and PDU objects; nil when the device exposes none.
func parsePower(w *Walk) *PowerFacts {
	p := &PowerFacts{}
	if m := w.scalarString(oidUpsIdentModel); m != "" {
		p.Kind = typeUps
		p.Model = m
		p.Manufacturer = w.scalarString(oidUpsIdentManufacturer)
		p.Firmware = w.scalarString(oidUpsIdentSoftware)
		// UPS-MIB carries no serial; a Liebert Unity card publishes the unit's in its agent identity (T-403).
		p.Serial = w.scalarString(oidLgpAgentIdentSerial)
		if v, ok := asInt(w.Scalars[oidUpsBatteryStatus]); ok {
			p.BatteryStatus = batteryStatusName(v)
		}
		p.MinutesRemaining, _ = asInt(w.Scalars[oidUpsMinutesRemaining])
		p.ChargePercent, _ = asInt(w.Scalars[oidUpsChargeRemaining])
		p.InputLineBads, _ = asInt(w.Scalars[oidUpsInputLineBads])
		if src, ok := asInt(w.Scalars[oidUpsOutputSource]); ok {
			p.OnBattery = src == upsSourceBattery
		}
		for _, v := range w.column(oidUpsOutputPercentLoad) {
			if n, ok := asInt(v); ok && n > p.LoadPercent {
				p.LoadPercent = n
			}
		}
		for _, v := range w.column(oidUpsOutputPower) {
			if n, ok := asInt(v); ok {
				p.OutputWatts += n
			}
		}
	}
	if s := w.scalarString(oidApcUpsSerial); s != "" {
		p.Kind = typeUps
		p.Serial = s
		p.Manufacturer = firstNonEmpty(p.Manufacturer, "APC")
		p.Model = firstNonEmpty(w.scalarString(oidApcUpsModel), p.Model)
		if v, ok := asInt(w.Scalars[oidApcUpsBatteryStatus]); ok && p.BatteryStatus == "" {
			p.BatteryStatus = batteryStatusName(v)
		}
		if v, ok := asInt(w.Scalars[oidApcUpsOutputLoad]); ok && p.LoadPercent == 0 {
			p.LoadPercent = v
		}
	}
	if s := w.scalarString(oidApcPduSerial); s != "" {
		p.Kind = typePdu
		p.Serial = s
		p.Manufacturer = "APC"
		p.Model = w.scalarString(oidApcPduModel)
		p.RatingAmps, _ = asInt(w.Scalars[oidApcPduRatingAmps])
		p.OutputWatts, p.OutputMetered = asInt(w.Scalars[oidApcPduPowerWatts])
		for _, v := range w.column(oidApcPduLoadTenthAmps) {
			if n, ok := asInt(v); ok {
				p.LoadAmps += float64(n) / tenths
			}
		}
		names := w.column(oidApcPduOutletName)
		states := w.column(oidApcPduOutletState)
		watts := w.column(oidApcPduOutletWatts)
		p.Outlets = outletsFrom(names, states, watts, apcOutletOn)
	}
	if s := w.scalarString(oidRaritanSerial); s != "" {
		p.Kind = typePdu
		p.Serial = s
		p.Manufacturer = "Raritan"
		p.Model = w.scalarString(oidRaritanModel)
		p.OutputWatts, p.OutputMetered = asInt(w.Scalars[oidRaritanInletPower])
		p.Outlets = outletsFrom(w.column(oidRaritanOutletName), nil, nil, 0)
	}
	if p.Kind == "" {
		return nil
	}
	return p
}

func outletsFrom(names, states, watts map[string]any, onValue int64) []Outlet {
	indexes := make([]string, 0, len(names))
	for idx := range names {
		indexes = append(indexes, idx)
	}
	sortNumeric(indexes)
	out := make([]Outlet, 0, len(indexes))
	for _, idx := range indexes {
		o := Outlet{Index: idx, Name: strings.TrimSpace(asString(names[idx]))}
		if states != nil {
			if v, ok := asInt(states[idx]); ok {
				on := v == onValue
				o.On = &on
			}
		}
		if watts != nil {
			o.Watts, o.Metered = asInt(watts[idx])
		}
		out = append(out, o)
	}
	return out
}

func sortNumeric(list []string) {
	for i := 1; i < len(list); i++ {
		for j := i; j > 0 && numericLess(list[j], list[j-1]); j-- {
			list[j], list[j-1] = list[j-1], list[j]
		}
	}
}

// powerAttributes merges the power facts into the device attributes.
func powerAttributes(p *PowerFacts, attrs map[string]any) {
	attrs["powerKind"] = p.Kind
	attrs["batteryStatus"] = p.BatteryStatus
	attrs["batteryMinutesRemaining"] = p.MinutesRemaining
	attrs["batteryChargePercent"] = p.ChargePercent
	attrs["onBattery"] = p.OnBattery
	attrs["loadPercent"] = p.LoadPercent
	attrs["loadAmps"] = p.LoadAmps
	attrs["ratingAmps"] = p.RatingAmps
	attrs["outputWatts"] = p.OutputWatts
	attrs["inputLineBads"] = p.InputLineBads
	attrs["outletCount"] = len(p.Outlets)
	if p.Kind == typeUps {
		switch {
		case p.OnBattery || p.BatteryStatus == "low" || p.BatteryStatus == "depleted":
			attrs["health"] = "degraded"
		case p.BatteryStatus == "normal":
			attrs["health"] = "healthy"
		}
	}
}
