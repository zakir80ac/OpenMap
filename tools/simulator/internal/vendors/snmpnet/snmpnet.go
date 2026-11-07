// REQ-QA-005 REQ-DISC-001 — simulated network devices over SNMP: every estate network_device (Arista EOS,
// Cisco NX-OS and IOS-XE, Palo Alto PAN-OS, Fortinet FortiOS) gets its own SNMPv3 agent on UDP
// (snmpd: engine discovery, USM authPriv with a per-device auth/priv protocol pair, the time window). Each
// agent serves what that device reports: MIB-II system and ifTable, IF-MIB ifXTable, IP-MIB ipAddrTable and
// ipNetToMediaTable, ENTITY-MIB entPhysicalTable (chassis, power supplies, fans), LLDP-MIB local and remote
// tables, BRIDGE-MIB dot1dBasePortTable, Q-BRIDGE-MIB VLANs, PVIDs and learned MACs (dot1qTpFdbTable),
// and, on Cisco devices facing Cisco neighbours, CISCO-CDP-MIB cdpCacheTable.
//
// Everything is rendered from the estate: interfaces, VLANs and access-port membership, addresses and the
// interface each sits on, and LLDP/CDP neighbours from the estate's connected_to links (seen from both
// ends). Values the estate does not carry are derived deterministically from the device serial and said so
// where they are made: the management interface's MAC, power-supply serials, engine boots, the ARP table
// (the peer address and MAC on each routed point-to-point link) and the MAC of a neighbour without a
// chassis ID. sysDescr follows each vendor's published format. VLAN 1 ("default") is added on bridges whose
// estate lists no VLAN 1, as every switch has it, and non-access bridge ports report PVID 1.
//
// Not rendered because the collector does not read them and the estate has no source: VRF tables
// (MPLS-L3VPN-STD-MIB), firewall policy, interface counters. F5 load balancers are another simulator's.
package snmpnet

import (
	"context"
	"crypto/sha256"
	"fmt"
	"math"
	"net"
	"sort"
	"strconv"
	"strings"
	"time"

	g "github.com/gosnmp/gosnmp"

	"github.com/openmap/openmap/tools/simulator/internal/estate"
	"github.com/openmap/openmap/tools/simulator/internal/protocols/snmpd"
	"github.com/openmap/openmap/tools/simulator/internal/sim"
)

const (
	// Standard MIB objects.
	oidSysDescr        = ".1.3.6.1.2.1.1.1.0"
	oidSysObjectID     = ".1.3.6.1.2.1.1.2.0"
	oidSysUpTime       = ".1.3.6.1.2.1.1.3.0"
	oidSysContact      = ".1.3.6.1.2.1.1.4.0"
	oidSysName         = ".1.3.6.1.2.1.1.5.0"
	oidSysLocation     = ".1.3.6.1.2.1.1.6.0"
	oidSysServices     = ".1.3.6.1.2.1.1.7.0"
	oidIfNumber        = ".1.3.6.1.2.1.2.1.0"
	oidIfEntry         = ".1.3.6.1.2.1.2.2.1"
	oidIfXEntry        = ".1.3.6.1.2.1.31.1.1.1"
	oidIPAddrEntry     = ".1.3.6.1.2.1.4.20.1"
	oidIPNetToMedia    = ".1.3.6.1.2.1.4.22.1"
	oidEntPhysical     = ".1.3.6.1.2.1.47.1.1.1.1"
	oidLldpLocal       = ".1.0.8802.1.1.2.1.3"
	oidLldpLocPort     = ".1.0.8802.1.1.2.1.3.7.1"
	oidLldpRemEntry    = ".1.0.8802.1.1.2.1.4.1.1"
	oidDot1dBasePort   = ".1.3.6.1.2.1.17.1.4.1"
	oidDot1qFdbEntry   = ".1.3.6.1.2.1.17.7.1.2.2.1"
	oidDot1qVlanStatic = ".1.3.6.1.2.1.17.7.1.4.3.1"
	oidDot1qPvid       = ".1.3.6.1.2.1.17.7.1.4.5.1.1"
	oidCdpCacheEntry   = ".1.3.6.1.4.1.9.9.23.1.2.1.1"

	// IANAifType, ifAdminStatus/ifOperStatus, ENTITY-MIB PhysicalClass, TruthValue, LLDP subtypes.
	ifTypeEthernet        = 6
	ifTypeOther           = 1
	ifTypeLoopback        = 24
	netSnmpEnterprise     = 8072
	statusUp              = 1
	statusDown            = 2
	statusTesting         = 3
	entClassChassis       = 3
	entClassPowerSupply   = 6
	entClassFan           = 7
	truthTrue             = 1
	truthFalse            = 2
	chassisSubtypeMAC     = 4
	portSubtypeIfName     = 5
	rowStatusActive       = 1
	fdbStatusLearned      = 3
	arpTypeDynamic        = 3
	cdpAddressTypeIP      = 1
	vlanDefault           = 1
	ipReasmMaxSize        = 65535
	broadcastLowBit       = 1
	lldpCapBridge         = 0x20 // lldpSystemCapabilitiesMap bit 2 (bridge), most significant bit first
	lldpCapRouter         = 0x08 // bit 4 (router)
	sysServicesSwitch     = 6    // datalink + internet layers (RFC 3418)
	sysServicesFirewall   = 72   // internet + end-to-end + applications
	mgmtSpeedMbps         = 1000
	mgmtMtu               = 1500
	defaultMtu            = 1500
	ticksPerSecond        = 100
	ticksWrap             = 1 << 32
	bitsPerMbps           = 1_000_000
	maxGauge32            = math.MaxUint32
	fanTrays              = 2
	psuIndexBase          = 100
	fanIndexBase          = 200
	macLen                = 6
	ouiLen                = 3
	engineBootsSpread     = 20
	lldpRemTimeMark       = 0
	engineTimeMax         = math.MaxInt32
	ipv4Bits              = 32
	privSuffix            = "priv"
	credentialTypeV3      = "snmp_v3"
	optionPort            = "port"
	defaultVlanName       = "default"
	collectorInterfaceTyp = "interface"
)

// Vendor simulates the estate's network devices.
type Vendor struct{}

func (Vendor) ID() string             { return "snmp-network" }
func (Vendor) Collector() string      { return "snmp" }
func (Vendor) Requirements() []string { return []string{"REQ-DISC-001"} }

// flavour is what differs between vendors' agents.
type flavour struct {
	enterprise   uint32
	mfg          string
	chassisIndex int
	// mgmtIfIndex is the management port's ifIndex; 0 means the next index after the front-panel ports.
	mgmtIfIndex int
	cdp         bool
	firewall    bool
	descr       func(model, version string) string
}

var flavours = map[string]flavour{
	"EOS": {enterprise: 30065, mfg: "Arista Networks", chassisIndex: 1, mgmtIfIndex: 999001, descr: func(m, v string) string {
		return "Arista Networks EOS version " + v + " running on an Arista Networks " + m
	}},
	"NX-OS": {enterprise: 9, mfg: "Cisco Systems, Inc.", chassisIndex: 10, mgmtIfIndex: 83886080, cdp: true, descr: func(m, v string) string {
		return "Cisco NX-OS(tm) " + strings.TrimPrefix(m, "Nexus ") + ", Software (NXOS 64-bit), Version " + v + ", RELEASE SOFTWARE Copyright (c) 2002-2024 by Cisco Systems, Inc."
	}},
	"IOS-XE": {enterprise: 9, mfg: "Cisco Systems, Inc.", chassisIndex: 1, cdp: true, descr: func(m, v string) string {
		return "Cisco IOS Software [Dublin], " + m + " Software, Version " + v + ", RELEASE SOFTWARE (fc5)\r\nCopyright (c) 1986-2024 by Cisco Systems, Inc."
	}},
	"PAN-OS": {enterprise: 25461, mfg: "Palo Alto Networks", chassisIndex: 1, firewall: true, descr: func(m, _ string) string {
		series := m
		if i := strings.LastIndexByte(m, '-'); i > 0 && len(m) > i+3 {
			series = m[:len(m)-2] + "00"
		}
		return "Palo Alto Networks " + series + " series firewall"
	}},
	"FortiOS": {enterprise: 12356, mfg: "Fortinet", chassisIndex: 1, firewall: true, descr: func(m, _ string) string {
		return strings.ReplaceAll(m, " ", "-")
	}},
}

// genericFlavour serves a device of an OS the simulator has no format for with the estate's own sysDescr.
func genericFlavour(c *estate.CI) flavour {
	return flavour{mfg: c.Str("manufacturer"), chassisIndex: 1, descr: func(string, string) string { return c.Str("sysDescr") }}
}

type secPair struct{ auth, priv string }

// secPairs are the USM protocol pairs the collector can configure; each device takes one by its serial so
// every pair runs against some agent.
var secPairs = []secPair{{"SHA", "AES"}, {"SHA256", "AES256"}, {"SHA512", "AES256C"}, {"SHA224", "AES192"}, {"SHA384", "AES192C"}, {"MD5", "DES"}}

var authProtocols = map[string]g.SnmpV3AuthProtocol{"MD5": g.MD5, "SHA": g.SHA, "SHA224": g.SHA224, "SHA256": g.SHA256, "SHA384": g.SHA384, "SHA512": g.SHA512}
var privProtocols = map[string]g.SnmpV3PrivProtocol{"DES": g.DES, "AES": g.AES, "AES192": g.AES192, "AES256": g.AES256, "AES192C": g.AES192C, "AES256C": g.AES256C}

type peer struct {
	iface  *estate.CI
	dev    *estate.CI
	port   string
	alias  string
	mac    []byte
	ips    []*estate.CI
	remote string // remote sysName
}

type port struct {
	ci         *estate.CI
	ifIndex    int
	name       string
	descr      string
	alias      string
	ifType     int
	mac        []byte
	mtu        int
	speedMbps  uint64
	admin      int
	oper       int
	bridgePort int
	pvid       int
	ips        []*estate.CI
	peers      []peer
}

type arpEntry struct {
	ifIndex int
	ip      *estate.CI
	mac     []byte
}

type vlanView struct {
	id   int
	name string
	ci   *estate.CI
}

type device struct {
	estate  *estate.Estate
	ci      *estate.CI
	fl      flavour
	serial  string
	chassis []byte
	ports   []*port
	mgmt    *port
	vlans   []vlanView
	bridge  bool
	arp     []arpEntry
	psus    int
	sec     secPair
}

func seed(parts ...string) []byte {
	sum := sha256.Sum256([]byte(strings.Join(parts, "\x00")))
	return sum[:]
}

// seededMAC is a MAC in the OUI of base (or a locally administered one) derived from the seed.
func seededMAC(base []byte, parts ...string) []byte {
	s := seed(parts...)
	mac := make([]byte, macLen)
	if len(base) == macLen {
		copy(mac, base[:ouiLen])
	} else {
		copy(mac, s[macLen:macLen+ouiLen])
		mac[0] = (mac[0] | 0x02) &^ 0x01
	}
	copy(mac[ouiLen:], s[:macLen-ouiLen])
	return mac
}

func parseMAC(s string) []byte {
	hw, err := net.ParseMAC(s)
	if err != nil || len(hw) != macLen {
		return nil
	}
	return hw
}

func ifTypeOf(name string) int {
	switch name {
	case "", "ethernetCsmacd":
		return ifTypeEthernet
	case "softwareLoopback":
		return ifTypeLoopback
	case "ieee8023adLag":
		return 161
	case "l3ipvlan":
		return 136
	case "propVirtual":
		return 53
	case "tunnel":
		return 131
	}
	return ifTypeOther
}

func statusOf(s string) int {
	switch s {
	case "up":
		return statusUp
	case "testing":
		return statusTesting
	}
	return statusDown
}

func ifIndexOf(c *estate.CI) int {
	n, err := strconv.Atoi(c.ID("ifIndex"))
	if err != nil {
		return int(c.Num("ifIndex", 0))
	}
	return n
}

// owner is the device an interface belongs to.
func owner(e *estate.Estate, iface *estate.CI) *estate.CI {
	for _, d := range e.To(iface, "contains") {
		if d.Type == "network_device" || d.Type == "load_balancer" {
			return d
		}
	}
	return nil
}

func sysNameOf(d *estate.CI) string {
	if s := d.Str("sysName"); s != "" {
		return s
	}
	return d.Name
}

func chassisOf(d *estate.CI) []byte {
	if mac := parseMAC(d.ID("chassisId")); mac != nil {
		return mac
	}
	// The estate has no chassis ID for this neighbour: derive one from its serial.
	return seededMAC(nil, "chassis", d.ID("serialNumber"), d.Name)
}

func descrOf(d *estate.CI) string {
	if fl, ok := flavours[d.Str("osName")]; ok {
		return fl.descr(d.Str("model"), d.Str("osVersion"))
	}
	return d.Str("sysDescr")
}

func load(e *estate.Estate, c *estate.CI) *device {
	fl, ok := flavours[c.Str("osName")]
	if !ok {
		fl = genericFlavour(c)
	}
	d := &device{estate: e, ci: c, fl: fl, serial: c.ID("serialNumber"), chassis: chassisOf(c)}
	h := seed("snmp-usm", d.serial, c.Name)
	d.sec = secPairs[int(h[0])%len(secPairs)]
	d.psus = len(e.From(c, "powered_by"))
	highest := 0
	vlanByCI := map[*estate.CI]int{}
	for _, child := range e.From(c, "contains") {
		switch child.Type {
		case collectorInterfaceTyp:
			p := &port{
				ci: child, ifIndex: ifIndexOf(child), name: child.ID("name"), descr: child.Str("ifDescr"), alias: child.Str("ifAlias"),
				ifType: ifTypeOf(child.Str("ifType")), mac: parseMAC(child.Str("ifPhysAddress")), mtu: int(child.Num("ifMtu", defaultMtu)),
				speedMbps: uint64(child.Num("ifSpeedMbps", 0)), admin: statusOf(child.Str("ifAdminStatus")), oper: statusOf(child.Str("ifOperStatus")),
			}
			if p.descr == "" {
				p.descr = p.name
			}
			p.ips = e.From(child, "uses_ip")
			for _, other := range append(e.From(child, "connected_to"), e.To(child, "connected_to")...) {
				od := owner(e, other)
				if od == nil {
					continue
				}
				p.peers = append(p.peers, peer{iface: other, dev: od, port: other.ID("name"), alias: other.Str("ifAlias"), mac: parseMAC(other.Str("ifPhysAddress")), ips: e.From(other, "uses_ip"), remote: sysNameOf(od)})
			}
			for _, v := range e.From(child, "in_vlan") {
				p.pvid = int(v.Num("vlanId", 0))
			}
			if p.ifIndex > highest {
				highest = p.ifIndex
			}
			d.ports = append(d.ports, p)
		case "vlan":
			id := int(child.Num("vlanId", 0))
			vlanByCI[child] = id
			d.vlans = append(d.vlans, vlanView{id: id, name: child.Str("name"), ci: child})
		}
	}
	sort.Slice(d.ports, func(i, j int) bool { return d.ports[i].ifIndex < d.ports[j].ifIndex })
	d.bridge = len(d.vlans) > 0
	if d.bridge {
		hasDefault := false
		for _, v := range d.vlans {
			hasDefault = hasDefault || v.id == vlanDefault
		}
		if !hasDefault {
			d.vlans = append(d.vlans, vlanView{id: vlanDefault, name: defaultVlanName})
		}
		bp := 0
		for _, p := range d.ports {
			// Routed ports (an address on the port itself) are not bridge ports.
			if len(p.ips) > 0 {
				continue
			}
			bp++
			p.bridgePort = bp
			if p.pvid == 0 {
				p.pvid = vlanDefault
			}
		}
	}
	sort.Slice(d.vlans, func(i, j int) bool { return d.vlans[i].id < d.vlans[j].id })
	// The management port carries the device's own addresses (uses_ip from the device).
	mgmtIPs := e.From(c, "uses_ip")
	if len(mgmtIPs) > 0 {
		name := mgmtIPs[0].Str("interface")
		if name == "" {
			name = "mgmt0"
		}
		idx := fl.mgmtIfIndex
		if idx == 0 {
			idx = highest + 1
		}
		// The estate has no MAC for the management port: derive one in the chassis OUI.
		d.mgmt = &port{ifIndex: idx, name: name, descr: name, ifType: ifTypeEthernet, mac: seededMAC(d.chassis, "mgmt", d.serial), mtu: mgmtMtu, speedMbps: mgmtSpeedMbps, admin: statusUp, oper: statusUp, ips: mgmtIPs}
	}
	// ARP: on each routed point-to-point link the device has resolved its peer's address on that subnet.
	for _, p := range d.ports {
		for _, local := range p.ips {
			_, subnet, err := net.ParseCIDR(local.Str("subnet"))
			if err != nil {
				continue
			}
			for _, pr := range p.peers {
				for _, rip := range pr.ips {
					if ip := net.ParseIP(rip.ID("address")); ip != nil && subnet.Contains(ip) && rip.ID("address") != local.ID("address") && pr.mac != nil {
						d.arp = append(d.arp, arpEntry{ifIndex: p.ifIndex, ip: rip, mac: pr.mac})
					}
				}
			}
		}
	}
	return d
}

func (d *device) allPorts() []*port {
	if d.mgmt == nil {
		return d.ports
	}
	return append(append([]*port{}, d.ports...), d.mgmt)
}

func netmask(ipCI *estate.CI) string {
	_, n, err := net.ParseCIDR(ipCI.Str("subnet"))
	if err != nil {
		return net.IP(net.CIDRMask(ipv4Bits, ipv4Bits)).String()
	}
	return net.IP(n.Mask).String()
}

func broadcastOK(ip string) bool { return net.ParseIP(ip).To4() != nil }

// mib renders the device's agent.
func (d *device) mib(uptime func() uint32) *snmpd.MIB {
	m := snmpd.NewMIB()
	c := d.ci
	model, version := c.Str("model"), c.Str("osVersion")
	m.Str(oidSysDescr, d.fl.descr(model, version))
	m.OID(oidSysObjectID, "."+strings.TrimPrefix(c.Str("sysObjectId"), "."))
	m.TicksFunc(oidSysUpTime, uptime)
	m.Str(oidSysContact, c.Str("sysContact"))
	m.Str(oidSysName, sysNameOf(c))
	m.Str(oidSysLocation, c.Str("sysLocation"))
	services := sysServicesSwitch
	if d.fl.firewall {
		services = sysServicesFirewall
	}
	m.Int(oidSysServices, services)

	ports := d.allPorts()
	m.Int(oidIfNumber, len(ports))
	for _, p := range ports {
		speed := p.speedMbps * bitsPerMbps
		if speed > maxGauge32 {
			speed = maxGauge32
		}
		m.Int(snmpd.Index(oidIfEntry+".1", p.ifIndex), p.ifIndex)
		m.Str(snmpd.Index(oidIfEntry+".2", p.ifIndex), p.descr)
		m.Int(snmpd.Index(oidIfEntry+".3", p.ifIndex), p.ifType)
		m.Int(snmpd.Index(oidIfEntry+".4", p.ifIndex), p.mtu)
		m.Gauge(snmpd.Index(oidIfEntry+".5", p.ifIndex), uint32(speed))
		m.Octets(snmpd.Index(oidIfEntry+".6", p.ifIndex), p.mac)
		m.Int(snmpd.Index(oidIfEntry+".7", p.ifIndex), p.admin)
		m.Int(snmpd.Index(oidIfEntry+".8", p.ifIndex), p.oper)
		m.Ticks(snmpd.Index(oidIfEntry+".9", p.ifIndex), 0)
		m.Str(snmpd.Index(oidIfXEntry+".1", p.ifIndex), p.name)
		m.Gauge(snmpd.Index(oidIfXEntry+".15", p.ifIndex), uint32(p.speedMbps))
		m.Int(snmpd.Index(oidIfXEntry+".16", p.ifIndex), truthFalse)
		m.Int(snmpd.Index(oidIfXEntry+".17", p.ifIndex), truthTrue)
		m.Str(snmpd.Index(oidIfXEntry+".18", p.ifIndex), p.alias)
		for _, ip := range p.ips {
			addr := ip.ID("address")
			if !broadcastOK(addr) {
				continue
			}
			m.IP(snmpd.Index(oidIPAddrEntry+".1", addr), addr)
			m.Int(snmpd.Index(oidIPAddrEntry+".2", addr), p.ifIndex)
			m.IP(snmpd.Index(oidIPAddrEntry+".3", addr), netmask(ip))
			m.Int(snmpd.Index(oidIPAddrEntry+".4", addr), broadcastLowBit)
			m.Int(snmpd.Index(oidIPAddrEntry+".5", addr), ipReasmMaxSize)
		}
	}
	for _, a := range d.arp {
		addr := a.ip.ID("address")
		m.Int(snmpd.Index(oidIPNetToMedia+".1", a.ifIndex, addr), a.ifIndex)
		m.Octets(snmpd.Index(oidIPNetToMedia+".2", a.ifIndex, addr), a.mac)
		m.IP(snmpd.Index(oidIPNetToMedia+".3", a.ifIndex, addr), addr)
		m.Int(snmpd.Index(oidIPNetToMedia+".4", a.ifIndex, addr), arpTypeDynamic)
	}
	d.entity(m)
	d.lldp(m)
	if d.bridge {
		d.qbridge(m)
	}
	if d.fl.cdp {
		d.cdp(m)
	}
	return m
}

func (d *device) entity(m *snmpd.MIB) {
	c := d.ci
	type ent struct {
		idx, class, parent, pos    int
		descr, name, serial, model string
		fru                        bool
	}
	ch := d.fl.chassisIndex
	list := []ent{{idx: ch, class: entClassChassis, pos: -1, descr: c.Str("model") + " Chassis", name: "Chassis", serial: d.serial, model: c.Str("model")}}
	psus := d.psus
	if psus == 0 {
		psus = 1
	}
	for i := 1; i <= psus; i++ {
		// The estate has no power-supply serials: derive each from the chassis serial.
		s := seed("psu", d.serial, strconv.Itoa(i))
		serial := strings.ToUpper(fmt.Sprintf("%x", s[:macLen]))
		list = append(list, ent{idx: ch*psuIndexBase + i, class: entClassPowerSupply, parent: ch, pos: i, descr: "Power supply " + strconv.Itoa(i), name: "PowerSupply" + strconv.Itoa(i), serial: serial, model: c.Str("model") + "-PSU", fru: true})
	}
	for i := 1; i <= fanTrays; i++ {
		list = append(list, ent{idx: ch*psuIndexBase + fanIndexBase + i, class: entClassFan, parent: ch, pos: i, descr: "Fan tray " + strconv.Itoa(i), name: "FanTray" + strconv.Itoa(i), fru: true})
	}
	for _, x := range list {
		fru := truthFalse
		if x.fru {
			fru = truthTrue
		}
		m.Str(snmpd.Index(oidEntPhysical+".2", x.idx), x.descr)
		m.OID(snmpd.Index(oidEntPhysical+".3", x.idx), "."+strings.TrimPrefix(c.Str("sysObjectId"), "."))
		m.Int(snmpd.Index(oidEntPhysical+".4", x.idx), x.parent)
		m.Int(snmpd.Index(oidEntPhysical+".5", x.idx), x.class)
		m.Int(snmpd.Index(oidEntPhysical+".6", x.idx), x.pos)
		m.Str(snmpd.Index(oidEntPhysical+".7", x.idx), x.name)
		m.Str(snmpd.Index(oidEntPhysical+".8", x.idx), "")
		m.Str(snmpd.Index(oidEntPhysical+".9", x.idx), "")
		sw := ""
		if x.class == entClassChassis {
			sw = c.Str("osVersion")
		}
		m.Str(snmpd.Index(oidEntPhysical+".10", x.idx), sw)
		m.Str(snmpd.Index(oidEntPhysical+".11", x.idx), x.serial)
		m.Str(snmpd.Index(oidEntPhysical+".12", x.idx), d.fl.mfg)
		m.Str(snmpd.Index(oidEntPhysical+".13", x.idx), x.model)
		m.Str(snmpd.Index(oidEntPhysical+".14", x.idx), "")
		asset := ""
		if x.class == entClassChassis {
			asset = c.Str("assetTag")
		}
		m.Str(snmpd.Index(oidEntPhysical+".15", x.idx), asset)
		m.Int(snmpd.Index(oidEntPhysical+".16", x.idx), fru)
	}
}

func (d *device) caps() []byte {
	if d.fl.firewall {
		return []byte{lldpCapRouter, 0}
	}
	return []byte{lldpCapBridge | lldpCapRouter, 0}
}

func peerCaps(p peer) []byte {
	if fl, ok := flavours[p.dev.Str("osName")]; ok && fl.firewall {
		return []byte{lldpCapRouter, 0}
	}
	return []byte{lldpCapBridge | lldpCapRouter, 0}
}

func (d *device) lldp(m *snmpd.MIB) {
	m.Int(oidLldpLocal+".1.0", chassisSubtypeMAC)
	m.Octets(oidLldpLocal+".2.0", d.chassis)
	m.Str(oidLldpLocal+".3.0", sysNameOf(d.ci))
	m.Str(oidLldpLocal+".4.0", d.fl.descr(d.ci.Str("model"), d.ci.Str("osVersion")))
	m.Octets(oidLldpLocal+".5.0", d.caps())
	m.Octets(oidLldpLocal+".6.0", d.caps())
	for _, p := range d.ports {
		m.Int(snmpd.Index(oidLldpLocPort+".2", p.ifIndex), portSubtypeIfName)
		m.Str(snmpd.Index(oidLldpLocPort+".3", p.ifIndex), p.name)
		m.Str(snmpd.Index(oidLldpLocPort+".4", p.ifIndex), p.alias)
		for i, pr := range p.peers {
			idx := []any{lldpRemTimeMark, p.ifIndex, i + 1}
			m.Int(snmpd.Index(oidLldpRemEntry+".4", idx...), chassisSubtypeMAC)
			m.Octets(snmpd.Index(oidLldpRemEntry+".5", idx...), chassisOf(pr.dev))
			m.Int(snmpd.Index(oidLldpRemEntry+".6", idx...), portSubtypeIfName)
			m.Str(snmpd.Index(oidLldpRemEntry+".7", idx...), pr.port)
			m.Str(snmpd.Index(oidLldpRemEntry+".8", idx...), pr.alias)
			m.Str(snmpd.Index(oidLldpRemEntry+".9", idx...), pr.remote)
			m.Str(snmpd.Index(oidLldpRemEntry+".10", idx...), descrOf(pr.dev))
			m.Octets(snmpd.Index(oidLldpRemEntry+".11", idx...), peerCaps(pr))
			m.Octets(snmpd.Index(oidLldpRemEntry+".12", idx...), peerCaps(pr))
		}
	}
}

func (d *device) qbridge(m *snmpd.MIB) {
	for _, p := range d.ports {
		if p.bridgePort == 0 {
			continue
		}
		m.Int(snmpd.Index(oidDot1dBasePort+".1", p.bridgePort), p.bridgePort)
		m.Int(snmpd.Index(oidDot1dBasePort+".2", p.bridgePort), p.ifIndex)
		m.Int(snmpd.Index(oidDot1qPvid, p.bridgePort), p.pvid)
		for _, pr := range p.peers {
			if pr.mac == nil {
				continue
			}
			m.Int(snmpd.Index(oidDot1qFdbEntry+".2", p.pvid, pr.mac), p.bridgePort)
			m.Int(snmpd.Index(oidDot1qFdbEntry+".3", p.pvid, pr.mac), fdbStatusLearned)
		}
	}
	for _, v := range d.vlans {
		m.Str(snmpd.Index(oidDot1qVlanStatic+".1", v.id), v.name)
		m.Int(snmpd.Index(oidDot1qVlanStatic+".5", v.id), rowStatusActive)
	}
}

func mgmtAddress(e *estate.Estate, dev *estate.CI) []byte {
	for _, ip := range e.From(dev, "uses_ip") {
		if v4 := net.ParseIP(ip.ID("address")).To4(); v4 != nil {
			return v4
		}
	}
	return nil
}

// cdp is CISCO-CDP-MIB cdpCacheTable: Cisco devices list their Cisco neighbours.
func (d *device) cdp(m *snmpd.MIB) {
	for _, p := range d.ports {
		n := 0
		for _, pr := range p.peers {
			if fl, ok := flavours[pr.dev.Str("osName")]; !ok || !fl.cdp {
				continue
			}
			n++
			idx := []any{p.ifIndex, n}
			m.Int(snmpd.Index(oidCdpCacheEntry+".3", idx...), cdpAddressTypeIP)
			if d.estate != nil {
				if addr := mgmtAddress(d.estate, pr.dev); addr != nil {
					m.Octets(snmpd.Index(oidCdpCacheEntry+".4", idx...), addr)
				}
			}
			m.Str(snmpd.Index(oidCdpCacheEntry+".5", idx...), descrOf(pr.dev))
			m.Str(snmpd.Index(oidCdpCacheEntry+".6", idx...), pr.remote)
			m.Str(snmpd.Index(oidCdpCacheEntry+".7", idx...), pr.port)
			m.Str(snmpd.Index(oidCdpCacheEntry+".8", idx...), "cisco "+pr.dev.Str("model"))
		}
	}
}

func macString(b []byte) string { return net.HardwareAddr(b).String() }

func (d *device) config(env *sim.Env) snmpd.Config {
	h := seed("snmp-engine", d.serial)
	uptime := d.ci.Num("sysUptimeSeconds", 0)
	if uptime > engineTimeMax {
		uptime = engineTimeMax
	}
	enterprise := d.fl.enterprise
	if enterprise == 0 {
		enterprise = netSnmpEnterprise
	}
	return snmpd.Config{
		User: &snmpd.User{
			Name: env.User, Auth: authProtocols[d.sec.auth], AuthPassphrase: env.Secret,
			Priv: privProtocols[d.sec.priv], PrivPassphrase: env.Token(privSuffix),
		},
		// The estate has no engine boots: a small count derived from the serial.
		EngineID: snmpd.EngineID(enterprise, d.chassis), EngineBoots: 1 + uint32(h[0])%engineBootsSpread, EngineTime: uint32(uptime),
	}
}

// uptimeTicks is sysUpTime: the estate uptime advanced by the time the agent has run, wrapping at 2^32.
func uptimeTicks(base float64) func() uint32 {
	started := time.Now()
	return func() uint32 {
		secs := base + time.Since(started).Seconds()
		return uint32(uint64(secs*ticksPerSecond) % ticksWrap)
	}
}

func devices(e *estate.Estate) []*estate.CI { return e.OfType("network_device", nil) }

func (Vendor) Start(_ context.Context, e *estate.Estate, env *sim.Env) (*sim.Endpoint, error) {
	ep := &sim.Endpoint{Host: sim.AdvertiseHost(), Devices: map[string]string{}, State: map[string]any{}}
	ports := map[string]int{}
	for _, c := range devices(e) {
		d := load(e, c)
		conn, port, err := sim.ListenUDP()
		if err != nil {
			_ = ep.Close()
			return nil, err
		}
		agent, err := snmpd.Serve(conn, d.mib(uptimeTicks(c.Num("sysUptimeSeconds", 0))), d.config(env))
		if err != nil {
			_ = conn.Close()
			_ = ep.Close()
			return nil, fmt.Errorf("%s: %w", c.Name, err)
		}
		ep.OnClose(agent.Close)
		ports[c.Name] = port
		ep.Devices[c.Name] = sim.Address(port)
	}
	ep.State["ports"] = ports
	return ep, nil
}

func (Vendor) Runs(e *estate.Estate, ep *sim.Endpoint, env *sim.Env) []sim.Run {
	ports, _ := ep.State["ports"].(map[string]int)
	var runs []sim.Run
	for _, c := range devices(e) {
		port, ok := ports[c.Name]
		if !ok {
			continue
		}
		d := load(e, c)
		run := sim.Run{
			Name:           c.Name,
			Targets:        []sim.Target{{Kind: "host", Value: sim.AdvertiseHost(), Label: c.Name}},
			Options:        map[string]any{optionPort: port},
			CredentialType: credentialTypeV3,
			Credential: &sim.Credential{Type: credentialTypeV3, Fields: map[string]string{
				"username": env.User, "authProtocol": d.sec.auth, "authPassphrase": env.Secret, "privProtocol": d.sec.priv, "privPassphrase": env.Token(privSuffix),
			}},
		}
		d.expect(&run.Expect)
		runs = append(runs, run)
	}
	return runs
}

// expect is what the collector must reconstruct from the agent: the device, every port with its facts,
// VLANs and access membership, addresses and the port each sits on, ARP-learned peers and LLDP neighbours.
func (d *device) expect(x *sim.Expect) {
	name := sysNameOf(d.ci)
	x.CIs = append(x.CIs, sim.ExpectCI{Type: "network_device", Name: name, Identity: d.ci.Identity, Attributes: map[string]any{
		"model": d.ci.Str("model"), "firmware": d.ci.Str("osVersion"), "manufacturer": d.fl.mfg, "sysLocation": d.ci.Str("sysLocation"), "sysContact": d.ci.Str("sysContact"),
		"sysObjectId": "." + strings.TrimPrefix(d.ci.Str("sysObjectId"), "."), "interfaceCount": len(d.allPorts()), "vlanCount": len(d.vlans),
	}})
	for _, p := range d.allPorts() {
		if p.ifType == ifTypeOther || p.ifType == ifTypeLoopback {
			continue
		}
		var identity map[string]string
		if p.ci != nil {
			identity = p.ci.Identity
		}
		x.CIs = append(x.CIs, sim.ExpectCI{Type: collectorInterfaceTyp, Name: p.name, Identity: identity, Attributes: map[string]any{
			"descr": p.descr, "alias": p.alias, "mtu": p.mtu, "speedBps": p.speedMbps * bitsPerMbps, "mac": macString(p.mac),
			"adminUp": p.admin == statusUp, "operUp": p.oper == statusUp, "pvid": p.pvid,
		}})
		x.Rel("contains", "network_device", name, collectorInterfaceTyp, p.name)
		if p.pvid > 0 {
			x.RelToRef("in_vlan", collectorInterfaceTyp, p.name, "vlan", map[string]string{"vlanId": strconv.Itoa(p.pvid)})
		}
		for _, ip := range p.ips {
			x.CIs = append(x.CIs, sim.ExpectCI{Type: "ip_address", Name: ip.Name, Identity: ip.Identity, Attributes: map[string]any{"netmask": netmask(ip), "ifIndex": p.ifIndex}})
			x.RelToRef("uses_ip", collectorInterfaceTyp, p.name, "ip_address", map[string]string{"address": ip.ID("address")})
		}
		for _, pr := range p.peers {
			if pr.dev.Type != "network_device" {
				continue
			}
			x.RelToRef("connected_to", collectorInterfaceTyp, p.name, "network_device", map[string]string{"chassisId": macString(chassisOf(pr.dev)), "sysName": pr.remote})
		}
	}
	for _, v := range d.vlans {
		var identity map[string]string
		if v.ci != nil {
			identity = v.ci.Identity
		}
		x.CIs = append(x.CIs, sim.ExpectCI{Type: "vlan", Name: v.name, Identity: identity, Attributes: map[string]any{"vlanId": v.id}})
		x.RelToRef("contains", "network_device", name, "vlan", map[string]string{"vlanId": strconv.Itoa(v.id)})
	}
	for _, a := range d.arp {
		x.CIs = append(x.CIs, sim.ExpectCI{Type: "ip_address", Name: a.ip.Name, Identity: a.ip.Identity, Attributes: map[string]any{"mac": macString(a.mac), "source": "arp", "seenOnIfIndex": a.ifIndex}})
	}
}
