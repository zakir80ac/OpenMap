// T-018 REQ-DISC-001 — parsing and emission over a walk assembled from Net-SNMP agent semantics.
// Vendor fixtures recorded from real devices live under packages/testing/fixtures/vendor/snmp and
// are loaded by walk_fixture_test.go when present.
package snmp

import (
	"testing"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

func walkFixture() *Walk {
	mac := func(s string) []byte { return []byte{0x00, 0x1c, 0x73, 0x00, 0x00, s[0]} }
	w := &Walk{Target: contract.Target{Kind: "host", Value: "10.20.0.1"}, Scalars: map[string]any{}, Tables: map[string][]Varbind{}, At: time.Date(2026, 10, 22, 9, 0, 0, 0, time.UTC)}
	w.Scalars[oidSysDescr] = []byte("Arista Networks EOS version 4.32.1F")
	w.Scalars[oidSysObjectID] = ".1.3.6.1.4.1.30065.1.3011.7050.3735.48.2878.3"
	w.Scalars[oidSysName] = []byte("sw-core-1")
	w.Scalars[oidSysUpTime] = uint64(864000)
	w.Scalars[oidLldpLocChassisID] = mac("a")
	w.Tables[oidEntPhysicalClass] = []Varbind{{oidEntPhysicalClass + ".1", int64(entClassChassis)}, {oidEntPhysicalClass + ".2", int64(entClassPowerSupply)}}
	w.Tables[oidEntPhysicalSerialNum] = []Varbind{{oidEntPhysicalSerialNum + ".1", []byte("JPE17420001")}, {oidEntPhysicalSerialNum + ".2", []byte("PSU-1")}}
	w.Tables[oidEntPhysicalModelName] = []Varbind{{oidEntPhysicalModelName + ".1", []byte("DCS-7050SX3-48YC8")}}
	w.Tables[oidEntPhysicalMfgName] = []Varbind{{oidEntPhysicalMfgName + ".1", []byte("Arista Networks")}}
	w.Tables[oidEntPhysicalSwRev] = []Varbind{{oidEntPhysicalSwRev + ".1", []byte("4.32.1F")}}
	w.Tables[oidIfDescr] = []Varbind{{oidIfDescr + ".1", []byte("Ethernet1")}, {oidIfDescr + ".2", []byte("Ethernet2")}, {oidIfDescr + ".999", []byte("Loopback0")}}
	w.Tables[oidIfName] = []Varbind{{oidIfName + ".1", []byte("Et1")}, {oidIfName + ".2", []byte("Et2")}, {oidIfName + ".999", []byte("Lo0")}}
	w.Tables[oidIfType] = []Varbind{{oidIfType + ".1", int64(6)}, {oidIfType + ".2", int64(6)}, {oidIfType + ".999", int64(ifTypeSoftwareLoopback)}}
	w.Tables[oidIfHighSpeed] = []Varbind{{oidIfHighSpeed + ".1", uint64(25000)}, {oidIfHighSpeed + ".2", uint64(25000)}}
	w.Tables[oidIfPhysAddress] = []Varbind{{oidIfPhysAddress + ".1", mac("1")}, {oidIfPhysAddress + ".2", mac("2")}}
	w.Tables[oidIfOperStatus] = []Varbind{{oidIfOperStatus + ".1", int64(ifStatusUp)}, {oidIfOperStatus + ".2", int64(ifStatusDown)}, {oidIfOperStatus + ".999", int64(ifStatusUp)}}
	w.Tables[oidIfAdminStatus] = []Varbind{{oidIfAdminStatus + ".1", int64(ifStatusUp)}, {oidIfAdminStatus + ".2", int64(ifStatusUp)}}
	w.Tables[oidDot1qVlanStaticName] = []Varbind{{oidDot1qVlanStaticName + ".204", []byte("db-tier")}, {oidDot1qVlanStaticName + ".1", []byte("default")}}
	w.Tables[oidDot1dBasePortIfIndex] = []Varbind{{oidDot1dBasePortIfIndex + ".1", int64(1)}}
	w.Tables[oidDot1qPvid] = []Varbind{{oidDot1qPvid + ".1", int64(204)}}
	w.Tables[oidIpAdEntIfIndex] = []Varbind{{oidIpAdEntIfIndex + ".10.254.0.1", int64(999)}}
	w.Tables[oidIpAdEntNetMask] = []Varbind{{oidIpAdEntNetMask + ".10.254.0.1", "255.255.255.255"}}
	w.Tables[oidLldpLocPortID] = []Varbind{{oidLldpLocPortID + ".1", []byte("Ethernet1")}}
	w.Tables[oidLldpRemChassisID] = []Varbind{{oidLldpRemChassisID + ".0.1.1", mac("b")}}
	w.Tables[oidLldpRemPortID] = []Varbind{{oidLldpRemPortID + ".0.1.1", []byte("Ethernet49")}}
	w.Tables[oidLldpRemSysName] = []Varbind{{oidLldpRemSysName + ".0.1.1", []byte("sw-r12-a")}}
	w.Tables[oidIpNetToMediaPhys] = []Varbind{{oidIpNetToMediaPhys + ".1.10.20.4.18", mac("c")}}
	return w
}

func TestParseDevice(t *testing.T) {
	d := Parse(walkFixture())
	if d.SysName != "sw-core-1" || d.Serial != "JPE17420001" || d.Model != "DCS-7050SX3-48YC8" || d.Manufacturer != "Arista Networks" {
		t.Fatalf("device fields wrong: %+v", d)
	}
	if d.ChassisID != "00:1c:73:00:00:61" {
		t.Fatalf("chassis id %q", d.ChassisID)
	}
	if len(d.Interfaces) != 3 || d.Interfaces[0].Name != "Et1" || d.Interfaces[0].SpeedBps != 25_000_000_000 || !d.Interfaces[0].OperUp || d.Interfaces[1].OperUp {
		t.Fatalf("interfaces wrong: %+v", d.Interfaces)
	}
	if d.Interfaces[0].Pvid != 204 {
		t.Fatalf("pvid not mapped through bridge port: %+v", d.Interfaces[0])
	}
	if len(d.Vlans) != 2 || d.Vlans[1].Name != "db-tier" {
		t.Fatalf("vlans wrong: %+v", d.Vlans)
	}
	if len(d.Neighbours) != 1 || d.Neighbours[0].RemoteSysName != "sw-r12-a" || d.Neighbours[0].LocalIfIndex != 1 {
		t.Fatalf("neighbours wrong: %+v", d.Neighbours)
	}
	if len(d.ArpEntries) != 1 || d.ArpEntries[0].IP != "10.20.4.18" {
		t.Fatalf("arp wrong: %+v", d.ArpEntries)
	}
}

func TestEmitObservations(t *testing.T) {
	w := walkFixture()
	d := Parse(w)
	obs := Emit(d, w.Target, []byte("raw"), w.At)
	var devices, ifaces, vlans, ips int
	for _, ci := range obs.Cis {
		switch ci.Type {
		case typeNetworkDevice:
			devices++
			if ci.Identity["serialNumber"] != "JPE17420001" || ci.Identity["chassisId"] == "" || ci.Identity["sysName"] != "sw-core-1" {
				t.Fatalf("device identity wrong: %+v", ci.Identity)
			}
		case typeInterface:
			ifaces++
		case typeVlan:
			vlans++
		case typeIPAddress:
			ips++
		}
	}
	if devices != 1 || ifaces != 2 || vlans != 2 || ips != 2 {
		t.Fatalf("counts devices=%d ifaces=%d vlans=%d ips=%d", devices, ifaces, vlans, ips)
	}
	var connected, inVlan, uses int
	for _, r := range obs.Relationships {
		switch r.Type {
		case relConnectedTo:
			connected++
			if r.To.Identity["sysName"] != "sw-r12-a" {
				t.Fatalf("lldp target wrong: %+v", r.To)
			}
		case relInVlan:
			inVlan++
		case relUsesIP:
			uses++
		}
	}
	if connected != 1 || inVlan != 1 || uses != 1 {
		t.Fatalf("relationships connected=%d inVlan=%d usesIp=%d", connected, inVlan, uses)
	}
	if len(obs.Evidence) != 1 || obs.Evidence[0].Kind != evidenceKind {
		t.Fatal("evidence missing")
	}
}

func TestUnknownWhenNoIdentity(t *testing.T) {
	w := &Walk{Target: contract.Target{Kind: "host", Value: "10.20.9.144"}, Scalars: map[string]any{oidSysDescr: []byte("Linux 5.15 armv7l")}, Tables: map[string][]Varbind{}, At: time.Now()}
	obs := Emit(Parse(w), w.Target, nil, w.At)
	if obs.Cis[0].Type != typeUnknown || obs.Cis[0].Identity["address"] != "10.20.9.144" {
		t.Fatalf("expected unknown CI keyed by address, got %+v", obs.Cis[0])
	}
}

func TestVendorFromSysObjectID(t *testing.T) {
	if vendorFromSysObjectID(".1.3.6.1.4.1.9.1.2494") != "Cisco" || vendorFromSysObjectID(".1.3.6.1.4.1.30065.1") != "Arista" || vendorFromSysObjectID("x") != "" {
		t.Fatal("vendor mapping wrong")
	}
}
