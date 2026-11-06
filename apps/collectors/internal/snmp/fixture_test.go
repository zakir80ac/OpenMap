// T-301 REQ-DISC-001 — recorded vendor fixtures: `snmpbulkwalk -On -m ”` captures (v2c and v3
// authPriv SHA/AES) from real Net-SNMP agents in the container lab are loaded into a Walk exactly as
// walkDevice builds one from gosnmp PDUs (same decoded Go types as decode()), then run through the
// collector's Parse and Emit. Fixtures live in packages/testing/fixtures/vendor/snmp.
package snmp

import (
	"bufio"
	"encoding/hex"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/collector"
	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

const snmpFixtureRoot = "../../../../packages/testing/fixtures/vendor/snmp"

// parseNetSnmpValue maps one net-snmp `TYPE: value` rendering (no MIBs loaded) to the Go value
// decode() produces for the same PDU. ok=false for exceptions (noSuchObject etc.), which decode drops.
func parseNetSnmpValue(t *testing.T, text string) (any, bool) {
	t.Helper()
	if text == `""` {
		return []byte{}, true
	}
	if strings.HasPrefix(text, "No Such Object") || strings.HasPrefix(text, "No Such Instance") || strings.HasPrefix(text, "No more variables") {
		return nil, false
	}
	typ, val, ok := strings.Cut(text, ": ")
	if !ok {
		t.Fatalf("unrecognised value rendering %q", text)
	}
	switch typ {
	case "STRING":
		s := strings.TrimSuffix(strings.TrimPrefix(val, `"`), `"`)
		s = strings.NewReplacer(`\"`, `"`, `\\`, `\`).Replace(s)
		return []byte(s), true
	case "Hex-STRING":
		b, err := hex.DecodeString(strings.Join(strings.Fields(val), ""))
		if err != nil {
			t.Fatalf("hex string %q: %v", val, err)
		}
		return b, true
	case "INTEGER":
		n, err := strconv.ParseInt(strings.TrimSpace(val), 10, 64)
		if err != nil {
			t.Fatalf("integer %q: %v", val, err)
		}
		return n, true
	case "Gauge32", "Counter32", "Counter64", "UInteger32":
		n, err := strconv.ParseUint(strings.TrimSpace(val), 10, 64)
		if err != nil {
			t.Fatalf("%s %q: %v", typ, val, err)
		}
		return n, true
	case "Timeticks":
		inner := strings.TrimPrefix(strings.SplitN(val, ")", 2)[0], "(")
		n, err := strconv.ParseUint(inner, 10, 64)
		if err != nil {
			t.Fatalf("timeticks %q: %v", val, err)
		}
		return n, true
	case "OID", "IpAddress":
		return strings.TrimSpace(val), true
	default:
		t.Fatalf("unhandled net-snmp type %q", typ)
		return nil, false
	}
}

// loadWalk reads a recorded walk and files every varbind the way walkDevice does: scalar GET OIDs
// into Scalars, and each table root's subtree into Tables[root].
func loadWalk(t *testing.T, path string, target contract.Target) *Walk {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	type pair struct{ oid, text string }
	var pairs []pair
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := sc.Text()
		if oid, val, ok := strings.Cut(line, " = "); ok && strings.HasPrefix(oid, ".") {
			pairs = append(pairs, pair{oid, val})
			continue
		}
		if len(pairs) == 0 {
			t.Fatalf("%s: continuation line before any varbind: %q", path, line)
		}
		pairs[len(pairs)-1].text += "\n" + line // multi-line STRING / Hex-STRING
	}
	if err := sc.Err(); err != nil {
		t.Fatal(err)
	}
	scalars := map[string]bool{}
	for _, list := range [][]string{scalarOIDs, powerScalarOIDs, coolingScalarOIDs} {
		for _, o := range list {
			scalars[o] = true
		}
	}
	w := &Walk{Target: target, Scalars: map[string]any{}, Tables: map[string][]Varbind{}, At: time.Date(2026, 11, 6, 20, 53, 0, 0, time.UTC)}
	for _, p := range pairs {
		v, ok := parseNetSnmpValue(t, p.text)
		if !ok {
			continue
		}
		if scalars[p.oid] {
			w.Scalars[p.oid] = v
		}
	}
	roots := append(append([]string{}, tableOIDs...), oidIpNetToMediaPhys)
	if parsePower(w) != nil {
		roots = append(roots, powerTableOIDs...)
	}
	if parseCooling(w, w.scalarString(oidSysObjectID)) != nil {
		roots = append(roots, coolingTableOIDs...)
	}
	for _, root := range roots {
		for _, p := range pairs {
			if !strings.HasPrefix(p.oid, root+".") {
				continue
			}
			if v, ok := parseNetSnmpValue(t, p.text); ok {
				w.Tables[root] = append(w.Tables[root], Varbind{OID: p.oid, Value: v})
			}
		}
	}
	return w
}

type snmpIface struct {
	ifIndex string
	name    string
	mac     string
	mtu     int64
	speed   uint64
}

type snmpNeighbour struct {
	localIfIndex string
	chassisID    string
	sysName      string
	portID       string
	portDescr    string
}

type snmpExpect struct {
	sysName      string
	sysObjectID  string
	vendor       string
	chassisID    string
	location     string
	interfaces   []snmpIface
	addresses    map[string]string // address -> ifIndex of the uses_ip source interface
	arp          map[string]string // address -> mac
	neighbours   []snmpNeighbour
	descrPrefix  string
	totalIfCount int
}

var snmpExpectations = map[string]snmpExpect{
	"net-snmp-snmpd-debian12-5.9.3": {
		sysName: "fxlab-snmp-deb12", sysObjectID: ".1.3.6.1.4.1.8072.3.2.10", vendor: "Net-SNMP", chassisID: "7e:27:66:3d:f5:bd",
		location: "OpenMap container lab, rack B", descrPrefix: "Linux fxlab-snmp-deb12 6.6.87.2-microsoft-standard-WSL2", totalIfCount: 3,
		interfaces: []snmpIface{
			{ifIndex: "2", name: "eth0", mac: "7e:27:66:3d:f5:bd", mtu: 1500, speed: 10_000_000_000},
			{ifIndex: "3", name: "swp1", mac: "e6:6f:03:45:3e:6c", mtu: 1500, speed: 10_000_000_000},
		},
		addresses:  map[string]string{"10.99.0.1": "3", "192.168.128.2": "2"},
		arp:        map[string]string{"192.168.128.1": "e2:cc:58:20:52:d2", "192.168.128.4": "9e:5c:65:b7:96:50"},
		neighbours: []snmpNeighbour{{localIfIndex: "3", chassisID: "d6:6f:33:b5:6d:5c", sysName: "lab-peer-sw01", portID: "d6:6f:33:b5:6d:5c", portDescr: "eth1"}},
	},
	"net-snmp-snmpd-alpine3.20-5.9.4": {
		sysName: "fxlab-snmp-alp320", sysObjectID: ".1.3.6.1.4.1.8072.3.2.10", vendor: "Net-SNMP",
		location: "OpenMap container lab, rack B", descrPrefix: "Linux fxlab-snmp-alp320 6.6.87.2-microsoft-standard-WSL2", totalIfCount: 2,
		interfaces: []snmpIface{{ifIndex: "2", name: "eth0", mac: "56:10:ad:7d:b1:9c", mtu: 1500, speed: 10_000_000_000}},
		addresses:  map[string]string{"192.168.128.3": "2"},
		arp:        map[string]string{"192.168.128.4": "9e:5c:65:b7:96:50"},
	},
	// The same agent configuration, hostname, MAC and address re-created and walked over SNMPv1 (T-317);
	// its ARP table also holds the bridge gateway it had just fetched packages through.
	"net-snmp-snmpd-alpine3.20-5.9.4-v1": {
		sysName: "fxlab-snmp-alp320", sysObjectID: ".1.3.6.1.4.1.8072.3.2.10", vendor: "Net-SNMP",
		location: "OpenMap container lab, rack B", descrPrefix: "Linux fxlab-snmp-alp320 6.6.87.2-microsoft-standard-WSL2", totalIfCount: 2,
		interfaces: []snmpIface{{ifIndex: "2", name: "eth0", mac: "56:10:ad:7d:b1:9c", mtu: 1500, speed: 10_000_000_000}},
		addresses:  map[string]string{"192.168.128.3": "2"},
		arp:        map[string]string{"192.168.128.1": "e6:87:77:aa:4c:af", "192.168.128.4": "9e:5c:65:b7:96:50"},
	},
}

func TestREQDISC001_T301_RecordedVendorFixtures(t *testing.T) {
	entries, err := os.ReadDir(snmpFixtureRoot)
	if err != nil {
		t.Fatalf("fixture root: %v", err)
	}
	dirs := 0
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		dirs++
		exp, ok := snmpExpectations[e.Name()]
		if !ok {
			t.Errorf("fixture %s has no expectation row", e.Name())
			continue
		}
		if _, err := os.Stat(filepath.Join(snmpFixtureRoot, e.Name(), "v2c.walk")); err != nil {
			if _, v1 := os.Stat(filepath.Join(snmpFixtureRoot, e.Name(), v1WalkFile)); v1 == nil {
				continue // an SNMPv1-only capture; T-317 runs it
			}
			t.Errorf("fixture %s has neither v2c.walk nor %s", e.Name(), v1WalkFile)
			continue
		}
		for _, walkFile := range []string{"v2c.walk", "v3.walk"} {
			t.Run(e.Name()+"/"+walkFile, func(t *testing.T) {
				target := contract.Target{Kind: "host", Value: exp.sysName}
				w := loadWalk(t, filepath.Join(snmpFixtureRoot, e.Name(), walkFile), target)
				d := Parse(w)
				if d.Manufacturer == "" {
					d.Manufacturer = vendorFromSysObjectID(d.SysObjectID) // as Collect does
				}
				assertSnmpDevice(t, d, exp)
				obs := Emit(d, target, []byte("walk"), w.At)
				assertSnmpObservation(t, obs, exp)
			})
		}
	}
	if dirs == 0 {
		t.Fatal("no recorded snmp fixtures found")
	}
}

func assertSnmpDevice(t *testing.T, d Device, exp snmpExpect) {
	t.Helper()
	if d.SysName != exp.sysName || d.SysObjectID != exp.sysObjectID || d.Manufacturer != exp.vendor || d.ChassisID != exp.chassisID || d.Location != exp.location {
		t.Fatalf("device identity: %+v", d)
	}
	if !strings.HasPrefix(d.SysDescr, exp.descrPrefix) || d.UptimeTicks <= 0 {
		t.Fatalf("sysDescr/uptime: %q %d", d.SysDescr, d.UptimeTicks)
	}
	if len(d.Interfaces) != exp.totalIfCount || d.Interfaces[0].Name != "lo" || d.Interfaces[0].Type != ifTypeSoftwareLoopback {
		t.Fatalf("interfaces (loopback first): %+v", d.Interfaces)
	}
	if d.Power != nil || d.Cooling != nil {
		t.Fatalf("net-snmp host must not be classified as power or cooling equipment: %+v %+v", d.Power, d.Cooling)
	}
	for _, a := range d.Addresses {
		if strings.HasPrefix(a.IP, "127.") {
			t.Fatalf("loopback address leaked into addresses: %+v", a)
		}
	}
}

func assertSnmpObservation(t *testing.T, obs collector.Observation, exp snmpExpect) {
	t.Helper()
	dev := obs.Cis[0]
	if dev.Type != typeNetworkDevice || dev.Identity["sysName"] != exp.sysName || dev.Identity["chassisId"] != exp.chassisID || dev.Name != exp.sysName {
		t.Fatalf("device CI: %+v", dev)
	}
	if dev.Attributes["manufacturer"] != exp.vendor || dev.Attributes["interfaceCount"] != exp.totalIfCount {
		t.Fatalf("device attributes: %+v", dev.Attributes)
	}
	ifaces := map[string]map[string]any{}
	addrs := map[string]bool{}
	arp := map[string]string{}
	for _, ci := range obs.Cis[1:] {
		switch ci.Type {
		case typeInterface:
			ifaces[ci.Identity["ifIndex"]] = ci.Attributes
			if ci.Identity["deviceRef"] != dev.Attributes["deviceRef"] {
				t.Fatalf("interface deviceRef %q != %q", ci.Identity["deviceRef"], dev.Attributes["deviceRef"])
			}
		case typeIPAddress:
			if ci.Identity["vrfRef"] != defaultVrf {
				t.Fatalf("ip_address identity must carry vrfRef: %+v", ci.Identity)
			}
			if ci.Attributes["source"] == "arp" {
				arp[ci.Identity["address"]] = ci.Attributes["mac"].(string)
			} else {
				addrs[ci.Identity["address"]] = true
			}
		default:
			t.Fatalf("unexpected CI type %s", ci.Type)
		}
	}
	if len(ifaces) != len(exp.interfaces) {
		t.Fatalf("interface CIs: want %d got %d (%v)", len(exp.interfaces), len(ifaces), ifaces)
	}
	for _, want := range exp.interfaces {
		got, ok := ifaces[want.ifIndex]
		if !ok || got["mac"] != want.mac || got["mtu"] != want.mtu || got["speedBps"] != want.speed || got["operUp"] != true {
			t.Fatalf("interface %s: want %+v got %+v", want.ifIndex, want, got)
		}
	}
	if len(addrs) != len(exp.addresses) {
		t.Fatalf("address CIs: want %v got %v", exp.addresses, addrs)
	}
	for a := range exp.addresses {
		if !addrs[a] {
			t.Fatalf("missing address CI %s", a)
		}
	}
	if len(arp) != len(exp.arp) {
		t.Fatalf("arp CIs: want %v got %v", exp.arp, arp)
	}
	for a, mac := range exp.arp {
		if arp[a] != mac {
			t.Fatalf("arp %s: want %s got %s", a, mac, arp[a])
		}
	}
	usesIP := map[string]string{}
	var lldp []contract.ObservedRelationship
	for _, r := range obs.Relationships {
		switch r.Type {
		case relUsesIP:
			usesIP[r.To.Identity["address"]] = r.From.Identity["ifIndex"]
		case relConnectedTo:
			lldp = append(lldp, r)
		}
	}
	for a, ifi := range exp.addresses {
		if usesIP[a] != ifi {
			t.Fatalf("uses_ip %s: want from ifIndex %s got %q", a, ifi, usesIP[a])
		}
	}
	if len(lldp) != len(exp.neighbours) {
		t.Fatalf("connected_to: want %d got %d", len(exp.neighbours), len(lldp))
	}
	for i, n := range exp.neighbours {
		r := lldp[i]
		if r.From.Identity["ifIndex"] != n.localIfIndex || r.To.Type != typeNetworkDevice || r.To.Identity["chassisId"] != n.chassisID || r.To.Identity["sysName"] != n.sysName ||
			r.Attributes["remotePortId"] != n.portID || r.Attributes["remotePortDescr"] != n.portDescr || r.Attributes["protocol"] != "lldp" {
			t.Fatalf("lldp neighbour: want %+v got %+v", n, r)
		}
	}
}
