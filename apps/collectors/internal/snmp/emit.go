// REQ-DISC-001 — turns a parsed Device into contract observations: the network_device CI, one
// interface CI per port, VLAN CIs, ip_address CIs, and connected_to relationships from LLDP plus
// uses_ip for addresses seen in ARP. Identity follows CI_IDENTITY_KEYS exactly.
package snmp

import (
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/collector"
	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

const (
	typeNetworkDevice = "network_device"
	typeInterface     = "interface"
	typeVlan          = "vlan"
	typeIPAddress     = "ip_address"
	typeUnknown       = "unknown"

	relContains    = "contains"
	relConnectedTo = "connected_to"
	relUsesIP      = "uses_ip"
	relInVlan      = "in_vlan"

	evidenceKind = "snmp_walk"
	// ip_address identity is (address, vrfRef) per CI_IDENTITY_KEYS; SNMP walks the global table.
	defaultVrf = "default"
	// Loopback and software interface types that are not physical ports (IANAifType).
	ifTypeSoftwareLoopback = 24
	ifTypeOther            = 1
)

// deviceRef is the identity collectors use to point at the device from its child CIs.
func deviceRef(d Device, target contract.Target) string {
	if d.Serial != "" {
		return "serial:" + d.Serial
	}
	if d.ChassisID != "" {
		return "chassis:" + d.ChassisID
	}
	return "sysname:" + firstNonEmpty(d.SysName, target.Value)
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

// Emit converts a parsed device into an Observation. `raw` is the serialised walk kept as evidence.
func Emit(d Device, target contract.Target, raw []byte, at time.Time) collector.Observation {
	obs := collector.Observation{Evidence: []collector.RawEvidence{{Kind: evidenceKind, Data: raw}}}
	identity := map[string]string{}
	if d.Serial != "" {
		identity["serialNumber"] = d.Serial
	}
	if d.ChassisID != "" {
		identity["chassisId"] = d.ChassisID
	}
	if d.SysName != "" {
		identity["sysName"] = d.SysName
	}
	ciType := typeNetworkDevice
	if d.Power != nil && d.Serial != "" {
		ciType = d.Power.Kind
	}
	if d.Cooling != nil {
		if d.Serial == "" && d.Cooling.Serial != "" {
			identity["serialNumber"] = d.Cooling.Serial
		}
		if identity["serialNumber"] != "" {
			ciType = typeCoolingUnit
		}
	}
	if len(identity) == 0 {
		// Nothing we can key on beyond the address: surface it as unknown for a person to label.
		ciType = typeUnknown
		identity["address"] = target.Value
	}
	ref := deviceRef(d, target)
	devRef := contract.CiRef{Type: ciType, Identity: identity}
	attrs := map[string]any{
		"sysDescr":       d.SysDescr,
		"sysObjectId":    d.SysObjectID,
		"sysLocation":    d.Location,
		"sysContact":     d.Contact,
		"managementIp":   target.Value,
		"manufacturer":   d.Manufacturer,
		"model":          d.Model,
		"firmware":       d.Firmware,
		"uptimeSeconds":  d.UptimeTicks / 100,
		"interfaceCount": len(d.Interfaces),
		"vlanCount":      len(d.Vlans),
		"deviceRef":      ref,
	}
	if d.Power != nil {
		powerAttributes(d.Power, attrs)
	}
	if d.Cooling != nil {
		coolingAttributes(d.Cooling, attrs)
		attrs["model"] = firstNonEmpty(d.Model, d.Cooling.Model)
		attrs["firmware"] = firstNonEmpty(d.Firmware, d.Cooling.Firmware)
	}
	obs.Cis = append(obs.Cis, contract.ObservedCi{Type: ciType, Identity: identity, Name: firstNonEmpty(d.SysName, target.Value), Attributes: attrs, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
	if d.Cooling != nil {
		obs.Samples = append(obs.Samples, coolingSamples(d.Cooling, devRef, at)...)
	}
	if d.Power != nil && ciType == typePdu {
		// REQ-DCIM-005: the PDU's total draw and each metered outlet's draw as samples, so power is a series.
		if d.Power.OutputMetered {
			obs.Samples = append(obs.Samples, contract.MetricSample{Ci: devRef, Metric: contract.MetricPduPower, Ts: at, Value: float64(d.Power.OutputWatts), Unit: contract.UnitWatts, Labels: map[string]string{"pdu": d.Serial}})
		}
		for _, o := range d.Power.Outlets {
			feedIdentity := map[string]string{"pduRef": d.Serial, "name": firstNonEmpty(o.Name, "outlet-"+o.Index)}
			feedAttrs := map[string]any{"outletIndex": o.Index, "watts": o.Watts, "pdu": d.Serial}
			if o.On != nil {
				feedAttrs["on"] = *o.On
			}
			obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typePowerFeed, Identity: feedIdentity, Name: feedIdentity["name"], Attributes: feedAttrs, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
			obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relContains, From: devRef, To: contract.CiRef{Type: typePowerFeed, Identity: feedIdentity}, Attributes: map[string]any{}, ObservedAt: at})
			if o.Metered {
				obs.Samples = append(obs.Samples, contract.MetricSample{Ci: contract.CiRef{Type: typePowerFeed, Identity: feedIdentity}, Metric: contract.MetricOutletPower, Ts: at, Value: float64(o.Watts), Unit: contract.UnitWatts, Labels: map[string]string{"pdu": d.Serial, "outlet": o.Index}})
			}
		}
	}

	ifByIndex := map[int64]Interface{}
	for _, it := range d.Interfaces {
		ifByIndex[it.IfIndex] = it
		if it.Type == ifTypeSoftwareLoopback || it.Type == ifTypeOther {
			continue
		}
		ifIdentity := map[string]string{"deviceRef": ref, "ifIndex": strconv.FormatInt(it.IfIndex, 10), "name": it.Name}
		ifAttrs := map[string]any{
			"descr": it.Descr, "alias": it.Alias, "ifType": it.Type, "mtu": it.Mtu, "speedBps": it.SpeedBps, "mac": it.Mac,
			"adminUp": it.AdminUp, "operUp": it.OperUp, "pvid": it.Pvid,
		}
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeInterface, Identity: ifIdentity, Name: it.Name, Attributes: ifAttrs, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
		ifRef := contract.CiRef{Type: typeInterface, Identity: ifIdentity}
		obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relContains, From: devRef, To: ifRef, Attributes: map[string]any{}, ObservedAt: at})
		if it.Pvid > 0 {
			obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relInVlan, From: ifRef, To: contract.CiRef{Type: typeVlan, Identity: map[string]string{"deviceRef": ref, "vlanId": strconv.FormatInt(it.Pvid, 10)}}, Attributes: map[string]any{"untagged": true}, ObservedAt: at})
		}
	}
	for _, v := range d.Vlans {
		vid := map[string]string{"deviceRef": ref, "vlanId": strconv.FormatInt(v.ID, 10)}
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeVlan, Identity: vid, Name: firstNonEmpty(v.Name, "VLAN "+strconv.FormatInt(v.ID, 10)), Attributes: map[string]any{"vlanId": v.ID}, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
		obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relContains, From: devRef, To: contract.CiRef{Type: typeVlan, Identity: vid}, Attributes: map[string]any{}, ObservedAt: at})
	}
	for _, a := range d.Addresses {
		ipIdentity := map[string]string{"address": a.IP, "vrfRef": defaultVrf}
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeIPAddress, Identity: ipIdentity, Name: a.IP, Attributes: map[string]any{"netmask": a.Netmask, "ifIndex": a.IfIndex, "assignedTo": ref}, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
		from := devRef
		if it, ok := ifByIndex[a.IfIndex]; ok && it.Type != ifTypeSoftwareLoopback {
			from = contract.CiRef{Type: typeInterface, Identity: map[string]string{"deviceRef": ref, "ifIndex": strconv.FormatInt(it.IfIndex, 10), "name": it.Name}}
		}
		obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relUsesIP, From: from, To: contract.CiRef{Type: typeIPAddress, Identity: ipIdentity}, Attributes: map[string]any{}, ObservedAt: at})
	}
	for _, n := range d.Neighbours {
		local, ok := ifByIndex[n.LocalIfIndex]
		if !ok {
			continue
		}
		remoteIdentity := map[string]string{}
		if n.RemoteChassisID != "" {
			remoteIdentity["chassisId"] = n.RemoteChassisID
		}
		if n.RemoteSysName != "" {
			remoteIdentity["sysName"] = n.RemoteSysName
		}
		if len(remoteIdentity) == 0 {
			continue
		}
		fromRef := contract.CiRef{Type: typeInterface, Identity: map[string]string{"deviceRef": ref, "ifIndex": strconv.FormatInt(local.IfIndex, 10), "name": local.Name}}
		attrs := map[string]any{"remotePortId": n.RemotePortID, "remotePortDescr": n.RemotePortDescr, "remoteSysDescr": n.RemoteSysDescr, "protocol": "lldp"}
		obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relConnectedTo, From: fromRef, To: contract.CiRef{Type: typeNetworkDevice, Identity: remoteIdentity}, Attributes: attrs, ObservedAt: at})
	}
	for _, e := range d.ArpEntries {
		// ARP tells us an address is live on a segment; the host behind it is resolved by other collectors.
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeIPAddress, Identity: map[string]string{"address": e.IP, "vrfRef": defaultVrf}, Name: e.IP, Attributes: map[string]any{"mac": e.Mac, "seenOnDevice": ref, "seenOnIfIndex": e.IfIndex, "source": "arp"}, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
	}
	return obs
}

// Summary is a one-line description for logs.
func Summary(d Device) string {
	return fmt.Sprintf("%s (%s %s) serial=%s ifaces=%d vlans=%d lldp=%d arp=%d", firstNonEmpty(d.SysName, "?"), d.Manufacturer, d.Model, d.Serial, len(d.Interfaces), len(d.Vlans), len(d.Neighbours), len(d.ArpEntries))
}

// vendorFromSysObjectID maps the enterprise number in sysObjectID to a vendor name for devices whose
// ENTITY-MIB is empty. Extend as vendors are recorded in the fixture lab.
func vendorFromSysObjectID(oid string) string {
	const enterprises = ".1.3.6.1.4.1."
	if !strings.HasPrefix(oid, enterprises) {
		return ""
	}
	rest := strings.TrimPrefix(oid, enterprises)
	num := strings.SplitN(rest, ".", 2)[0]
	switch num {
	case "9":
		return "Cisco"
	case "30065":
		return "Arista"
	case "2636":
		return "Juniper"
	case "11":
		return "HPE"
	case "25506":
		return "H3C"
	case "12356":
		return "Fortinet"
	case "25461":
		return "Palo Alto Networks"
	case "1991":
		return "Brocade"
	case "674":
		return "Dell"
	case "232":
		return "HPE ProLiant"
	case "8072":
		return "Net-SNMP"
	default:
		return ""
	}
}
