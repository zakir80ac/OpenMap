// T-554 REQ-IPAM-004 — bridge forwarding databases over walks assembled from BRIDGE-MIB and Q-BRIDGE-MIB semantics
// (RFC 4188, RFC 4363): learned entries are mapped through dot1dBasePortIfIndex to the interface that learned them,
// the switch's own (self, mgmt) entries are left out, Q-BRIDGE wins over BRIDGE-MIB when both answer, the list is
// capped with the full count kept, and a switch that answers neither table reports no learned MACs at all (so an
// earlier sweep's are kept). A recorded switch capture replaces these walks once the vendor lab exists (REQ-DISC-001).
package snmp

import (
	"fmt"
	"testing"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

func fdbWalk() *Walk {
	w := &Walk{Target: contract.Target{Kind: "host", Value: "10.20.0.2"}, Scalars: map[string]any{}, Tables: map[string][]Varbind{}, At: time.Date(2026, 11, 10, 9, 0, 0, 0, time.UTC)}
	w.Scalars[oidSysDescr] = []byte("Arista Networks EOS version 4.32.1F")
	w.Scalars[oidSysName] = []byte("sw-tor-1")
	w.Tables[oidEntPhysicalClass] = []Varbind{{oidEntPhysicalClass + ".1", int64(entClassChassis)}}
	w.Tables[oidEntPhysicalSerialNum] = []Varbind{{oidEntPhysicalSerialNum + ".1", []byte("JPE17420002")}}
	w.Tables[oidIfDescr] = []Varbind{{oidIfDescr + ".1", []byte("Ethernet1")}, {oidIfDescr + ".2", []byte("Ethernet2")}, {oidIfDescr + ".3", []byte("Ethernet3")}}
	w.Tables[oidIfType] = []Varbind{{oidIfType + ".1", int64(6)}, {oidIfType + ".2", int64(6)}, {oidIfType + ".3", int64(6)}}
	w.Tables[oidIfOperStatus] = []Varbind{{oidIfOperStatus + ".1", int64(ifStatusUp)}, {oidIfOperStatus + ".2", int64(ifStatusUp)}, {oidIfOperStatus + ".3", int64(ifStatusDown)}}
	// Bridge port 1 is ifIndex 1, bridge port 2 is ifIndex 2.
	w.Tables[oidDot1dBasePortIfIndex] = []Varbind{{oidDot1dBasePortIfIndex + ".1", int64(1)}, {oidDot1dBasePortIfIndex + ".2", int64(2)}}
	return w
}

func interfaceAttrs(t *testing.T, w *Walk) map[string]map[string]any {
	t.Helper()
	obs := Emit(Parse(w), w.Target, nil, w.At)
	out := map[string]map[string]any{}
	for _, ci := range obs.Cis {
		if ci.Type == typeInterface {
			out[ci.Identity["name"]] = ci.Attributes
		}
	}
	return out
}

func TestREQIPAM004_QBridgeLearnedMacsPerPort(t *testing.T) {
	w := fdbWalk()
	// fdbId 204 (the VLAN) then the six MAC octets.
	w.Tables[oidDot1qTpFdbPort] = []Varbind{
		{oidDot1qTpFdbPort + ".204.0.80.86.1.2.3", int64(1)},
		{oidDot1qTpFdbPort + ".204.0.80.86.1.2.4", int64(1)},
		{oidDot1qTpFdbPort + ".1.170.187.204.221.238.255", int64(2)},
		{oidDot1qTpFdbPort + ".204.0.80.86.1.2.9", int64(7)},
	}
	w.Tables[oidDot1qTpFdbStatus] = []Varbind{
		{oidDot1qTpFdbStatus + ".204.0.80.86.1.2.3", int64(3)},
		{oidDot1qTpFdbStatus + ".204.0.80.86.1.2.4", int64(4)},
		{oidDot1qTpFdbStatus + ".1.170.187.204.221.238.255", int64(3)},
		{oidDot1qTpFdbStatus + ".204.0.80.86.1.2.9", int64(3)},
	}
	// A BRIDGE-MIB entry the switch also answers is ignored when Q-BRIDGE has entries.
	w.Tables[oidDot1dTpFdbPort] = []Varbind{{oidDot1dTpFdbPort + ".0.80.86.9.9.9", int64(1)}}
	attrs := interfaceAttrs(t, w)
	if got := fmt.Sprint(attrs["Ethernet1"]["learnedMacs"]); got != "[00:50:56:01:02:03]" {
		t.Fatalf("Ethernet1 learned %s (self entry and BRIDGE-MIB entry must be left out)", got)
	}
	if got := fmt.Sprint(attrs["Ethernet2"]["learnedMacs"]); got != "[aa:bb:cc:dd:ee:ff]" {
		t.Fatalf("Ethernet2 learned %s", got)
	}
	if got := fmt.Sprint(attrs["Ethernet3"]["learnedMacs"]); got != "[]" {
		t.Fatalf("Ethernet3 learned %s, want an empty list (a port that lost its MACs is reported empty)", got)
	}
	if attrs["Ethernet1"]["learnedMacCount"] != 1 || attrs["Ethernet3"]["learnedMacCount"] != 0 {
		t.Fatalf("counts %v %v", attrs["Ethernet1"]["learnedMacCount"], attrs["Ethernet3"]["learnedMacCount"])
	}
}

func TestREQIPAM004_BridgeMibFallbackAndCap(t *testing.T) {
	w := fdbWalk()
	rows := []Varbind{}
	for i := 0; i < maxLearnedMacs+6; i++ {
		rows = append(rows, Varbind{fmt.Sprintf("%s.0.80.86.0.%d.%d", oidDot1dTpFdbPort, i/256, i%256), int64(2)})
	}
	w.Tables[oidDot1dTpFdbPort] = rows
	attrs := interfaceAttrs(t, w)
	macs, ok := attrs["Ethernet2"]["learnedMacs"].([]string)
	if !ok || len(macs) != maxLearnedMacs {
		t.Fatalf("Ethernet2 kept %d MACs, want the cap %d", len(macs), maxLearnedMacs)
	}
	if macs[0] != "00:50:56:00:00:00" {
		t.Fatalf("MACs are not sorted: first %s", macs[0])
	}
	if attrs["Ethernet2"]["learnedMacCount"] != maxLearnedMacs+6 {
		t.Fatalf("count %v, want the full %d", attrs["Ethernet2"]["learnedMacCount"], maxLearnedMacs+6)
	}
}

func TestREQIPAM004_NoForwardingTableKeepsEarlierMacs(t *testing.T) {
	attrs := interfaceAttrs(t, fdbWalk())
	if _, present := attrs["Ethernet1"]["learnedMacs"]; present {
		t.Fatal("a switch without a forwarding table must not report learnedMacs, or it would empty what an earlier sweep saw")
	}
}

func TestREQIPAM004_MacFromIndex(t *testing.T) {
	if got := macFromIndex([]string{"0", "80", "86", "1", "2", "3"}); got != "00:50:56:01:02:03" {
		t.Fatalf("got %q", got)
	}
	if got := macFromIndex([]string{"0", "80", "86", "1", "2"}); got != "" {
		t.Fatalf("five octets gave %q", got)
	}
	if got := macFromIndex([]string{"0", "80", "86", "1", "2", "300"}); got != "" {
		t.Fatalf("an octet over 255 gave %q", got)
	}
}
