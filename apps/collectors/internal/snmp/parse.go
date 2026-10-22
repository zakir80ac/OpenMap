// REQ-DISC-001 — pure parsing of walked SNMP tables into contract observations. Kept free of network
// code so recorded walks (packages/testing/fixtures/vendor/snmp) drive the tests.
package snmp

import (
	"fmt"
	"net"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

// Varbind is one walked OID/value pair with the value already decoded to a Go type:
// string, []byte, int64, uint64 or nil.
type Varbind struct {
	OID   string
	Value any
}

// Walk is everything collected from one device, keyed by table OID prefix.
type Walk struct {
	Target  contract.Target
	Scalars map[string]any
	Tables  map[string][]Varbind
	At      time.Time
}

func (w *Walk) scalarString(oid string) string {
	return asString(w.Scalars[oid])
}

func asString(v any) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return strings.TrimSpace(t)
	case []byte:
		return strings.TrimSpace(string(t))
	case int64:
		return strconv.FormatInt(t, 10)
	case uint64:
		return strconv.FormatUint(t, 10)
	default:
		return fmt.Sprint(t)
	}
}

func asInt(v any) (int64, bool) {
	switch t := v.(type) {
	case int64:
		return t, true
	case uint64:
		return int64(t), true
	case int:
		return int64(t), true
	default:
		return 0, false
	}
}

func macString(v any) string {
	b, ok := v.([]byte)
	if !ok || len(b) != 6 {
		return ""
	}
	return net.HardwareAddr(b).String()
}

// index returns the trailing index of an OID under a table prefix: ".1.3.6.1.2.1.2.2.1.2.7" under
// ifDescr → "7".
func index(prefix, oid string) string {
	return strings.TrimPrefix(strings.TrimPrefix(oid, prefix), ".")
}

func (w *Walk) column(prefix string) map[string]any {
	out := map[string]any{}
	for _, vb := range w.Tables[prefix] {
		out[index(prefix, vb.OID)] = vb.Value
	}
	return out
}

// Device is the parsed view of a network device walk.
type Device struct {
	SysName      string
	SysDescr     string
	SysObjectID  string
	Location     string
	Contact      string
	UptimeTicks  int64
	Serial       string
	Manufacturer string
	Model        string
	Firmware     string
	ChassisID    string
	Interfaces   []Interface
	Vlans        []Vlan
	Neighbours   []Neighbour
	ArpEntries   []ArpEntry
	Addresses    []Address
}

type Interface struct {
	IfIndex  int64
	Name     string
	Descr    string
	Alias    string
	Type     int64
	Mtu      int64
	SpeedBps uint64
	Mac      string
	AdminUp  bool
	OperUp   bool
	Pvid     int64
}

type Vlan struct {
	ID   int64
	Name string
}

type Neighbour struct {
	LocalIfIndex    int64
	LocalPortID     string
	RemoteChassisID string
	RemotePortID    string
	RemotePortDescr string
	RemoteSysName   string
	RemoteSysDescr  string
}

type ArpEntry struct {
	IfIndex int64
	IP      string
	Mac     string
}

type Address struct {
	IP      string
	Netmask string
	IfIndex int64
}

// Parse turns a walk into a Device. Missing tables are tolerated: a printer answers sysDescr and
// little else, and the result is still a valid, smaller CI.
func Parse(w *Walk) Device {
	d := Device{
		SysName:     w.scalarString(oidSysName),
		SysDescr:    w.scalarString(oidSysDescr),
		SysObjectID: w.scalarString(oidSysObjectID),
		Location:    w.scalarString(oidSysLocation),
		Contact:     w.scalarString(oidSysContact),
	}
	if up, ok := asInt(w.Scalars[oidSysUpTime]); ok {
		d.UptimeTicks = up
	}
	if cid, ok := w.Scalars[oidLldpLocChassisID]; ok {
		if mac := macString(cid); mac != "" {
			d.ChassisID = mac
		} else {
			d.ChassisID = asString(cid)
		}
	}
	d.parseEntity(w)
	d.parseInterfaces(w)
	d.parseVlans(w)
	d.parseNeighbours(w)
	d.parseArp(w)
	d.parseAddresses(w)
	return d
}

// parseEntity takes serial, model, manufacturer and firmware from the chassis entry of entPhysicalTable.
func (d *Device) parseEntity(w *Walk) {
	classes := w.column(oidEntPhysicalClass)
	serials := w.column(oidEntPhysicalSerialNum)
	models := w.column(oidEntPhysicalModelName)
	mfgs := w.column(oidEntPhysicalMfgName)
	fws := w.column(oidEntPhysicalSwRev)
	descrs := w.column(oidEntPhysicalDescr)
	// Prefer the lowest-indexed chassis with a serial; fall back to any entry with a serial.
	var keys []string
	for k := range classes {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool { return numericLess(keys[i], keys[j]) })
	pick := ""
	for _, k := range keys {
		if c, ok := asInt(classes[k]); ok && c == entClassChassis && asString(serials[k]) != "" {
			pick = k
			break
		}
	}
	if pick == "" {
		for _, k := range keys {
			if asString(serials[k]) != "" {
				pick = k
				break
			}
		}
	}
	if pick == "" {
		return
	}
	d.Serial = asString(serials[pick])
	d.Model = asString(models[pick])
	d.Manufacturer = asString(mfgs[pick])
	d.Firmware = asString(fws[pick])
	if d.Model == "" {
		d.Model = asString(descrs[pick])
	}
}

func (d *Device) parseInterfaces(w *Walk) {
	descr := w.column(oidIfDescr)
	names := w.column(oidIfName)
	alias := w.column(oidIfAlias)
	types := w.column(oidIfType)
	mtu := w.column(oidIfMtu)
	speed := w.column(oidIfSpeed)
	high := w.column(oidIfHighSpeed)
	phys := w.column(oidIfPhysAddress)
	admin := w.column(oidIfAdminStatus)
	oper := w.column(oidIfOperStatus)
	pvid := w.column(oidDot1qPvid)
	portIf := w.column(oidDot1dBasePortIfIndex)
	pvidByIf := map[string]int64{}
	for port, v := range pvid {
		if ifi, ok := asInt(portIf[port]); ok {
			if p, ok := asInt(v); ok {
				pvidByIf[strconv.FormatInt(ifi, 10)] = p
			}
		}
	}
	for idx := range descr {
		i, err := strconv.ParseInt(idx, 10, 64)
		if err != nil {
			continue
		}
		it := Interface{IfIndex: i, Descr: asString(descr[idx]), Name: asString(names[idx]), Alias: asString(alias[idx]), Mac: macString(phys[idx])}
		if it.Name == "" {
			it.Name = it.Descr
		}
		it.Type, _ = asInt(types[idx])
		it.Mtu, _ = asInt(mtu[idx])
		if hs, ok := asInt(high[idx]); ok && hs > 0 {
			it.SpeedBps = uint64(hs) * 1_000_000
		} else if s, ok := asInt(speed[idx]); ok {
			it.SpeedBps = uint64(s)
		}
		if a, ok := asInt(admin[idx]); ok {
			it.AdminUp = a == ifStatusUp
		}
		if o, ok := asInt(oper[idx]); ok {
			it.OperUp = o == ifStatusUp
		}
		it.Pvid = pvidByIf[idx]
		d.Interfaces = append(d.Interfaces, it)
	}
	sort.Slice(d.Interfaces, func(a, b int) bool { return d.Interfaces[a].IfIndex < d.Interfaces[b].IfIndex })
}

func (d *Device) parseVlans(w *Walk) {
	for idx, v := range w.column(oidDot1qVlanStaticName) {
		id, err := strconv.ParseInt(idx, 10, 64)
		if err != nil {
			continue
		}
		d.Vlans = append(d.Vlans, Vlan{ID: id, Name: asString(v)})
	}
	sort.Slice(d.Vlans, func(a, b int) bool { return d.Vlans[a].ID < d.Vlans[b].ID })
}

// parseNeighbours reads lldpRemTable, indexed by timeMark.localPortNum.remIndex.
func (d *Device) parseNeighbours(w *Walk) {
	chassis := w.column(oidLldpRemChassisID)
	portID := w.column(oidLldpRemPortID)
	portDesc := w.column(oidLldpRemPortDesc)
	sysName := w.column(oidLldpRemSysName)
	sysDesc := w.column(oidLldpRemSysDesc)
	locPort := w.column(oidLldpLocPortID)
	for idx, c := range chassis {
		parts := strings.Split(idx, ".")
		if len(parts) != 3 {
			continue
		}
		localPort, err := strconv.ParseInt(parts[1], 10, 64)
		if err != nil {
			continue
		}
		n := Neighbour{LocalIfIndex: localPort, RemoteSysName: asString(sysName[idx]), RemoteSysDescr: asString(sysDesc[idx]), RemotePortDescr: asString(portDesc[idx])}
		if mac := macString(c); mac != "" {
			n.RemoteChassisID = mac
		} else {
			n.RemoteChassisID = asString(c)
		}
		if mac := macString(portID[idx]); mac != "" {
			n.RemotePortID = mac
		} else {
			n.RemotePortID = asString(portID[idx])
		}
		n.LocalPortID = asString(locPort[parts[1]])
		d.Neighbours = append(d.Neighbours, n)
	}
	sort.Slice(d.Neighbours, func(a, b int) bool {
		if d.Neighbours[a].LocalIfIndex != d.Neighbours[b].LocalIfIndex {
			return d.Neighbours[a].LocalIfIndex < d.Neighbours[b].LocalIfIndex
		}
		return d.Neighbours[a].RemoteChassisID < d.Neighbours[b].RemoteChassisID
	})
}

// parseArp reads ipNetToMediaPhysAddress, indexed by ifIndex.a.b.c.d.
func (d *Device) parseArp(w *Walk) {
	for idx, v := range w.column(oidIpNetToMediaPhys) {
		parts := strings.SplitN(idx, ".", 2)
		if len(parts) != 2 {
			continue
		}
		ifi, err := strconv.ParseInt(parts[0], 10, 64)
		if err != nil || net.ParseIP(parts[1]) == nil {
			continue
		}
		if mac := macString(v); mac != "" {
			d.ArpEntries = append(d.ArpEntries, ArpEntry{IfIndex: ifi, IP: parts[1], Mac: mac})
		}
	}
	sort.Slice(d.ArpEntries, func(a, b int) bool { return d.ArpEntries[a].IP < d.ArpEntries[b].IP })
}

func (d *Device) parseAddresses(w *Walk) {
	ifIdx := w.column(oidIpAdEntIfIndex)
	masks := w.column(oidIpAdEntNetMask)
	for ip, v := range ifIdx {
		if net.ParseIP(ip) == nil {
			continue
		}
		ifi, _ := asInt(v)
		d.Addresses = append(d.Addresses, Address{IP: ip, Netmask: asString(masks[ip]), IfIndex: ifi})
	}
	sort.Slice(d.Addresses, func(a, b int) bool { return d.Addresses[a].IP < d.Addresses[b].IP })
}

func numericLess(a, b string) bool {
	ai, errA := strconv.Atoi(a)
	bi, errB := strconv.Atoi(b)
	if errA == nil && errB == nil {
		return ai < bi
	}
	return a < b
}
