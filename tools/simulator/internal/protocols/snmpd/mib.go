// REQ-QA-005 REQ-DISC-001 REQ-DISC-026 — the object tree a simulated SNMP agent serves: OIDs parsed into
// sub-identifier arrays and kept in true lexicographic order (component by component as unsigned integers,
// a prefix before its extensions, RFC 3416 §4.2.2), so GETNEXT and GETBULK walk exactly as a device agent does.
package snmpd

import (
	"fmt"
	"sort"
	"strconv"
	"strings"

	g "github.com/gosnmp/gosnmp"
)

// OID is an object identifier as its sub-identifiers.
type OID []uint32

// ParseOID reads dotted notation with or without the leading dot.
func ParseOID(s string) (OID, error) {
	s = strings.TrimPrefix(strings.TrimSpace(s), ".")
	if s == "" {
		return nil, fmt.Errorf("empty OID")
	}
	parts := strings.Split(s, ".")
	out := make(OID, len(parts))
	for i, p := range parts {
		n, err := strconv.ParseUint(p, 10, 32)
		if err != nil {
			return nil, fmt.Errorf("OID %q: sub-identifier %q: %w", s, p, err)
		}
		out[i] = uint32(n)
	}
	return out, nil
}

// String renders the OID with a leading dot, the form gosnmp reports names in.
func (o OID) String() string {
	var b strings.Builder
	for _, n := range o {
		b.WriteByte('.')
		b.WriteString(strconv.FormatUint(uint64(n), 10))
	}
	return b.String()
}

// Compare orders OIDs lexicographically: -1 when a sorts before b, 0 when equal, 1 after.
func Compare(a, b OID) int {
	for i := 0; i < len(a) && i < len(b); i++ {
		switch {
		case a[i] < b[i]:
			return -1
		case a[i] > b[i]:
			return 1
		}
	}
	switch {
	case len(a) < len(b):
		return -1
	case len(a) > len(b):
		return 1
	}
	return 0
}

// HasPrefix reports whether p is a prefix of o (or equal to it).
func (o OID) HasPrefix(p OID) bool {
	if len(p) > len(o) {
		return false
	}
	for i := range p {
		if o[i] != p[i] {
			return false
		}
	}
	return true
}

type entry struct {
	oid OID
	typ g.Asn1BER
	val any
	// fn, when set, computes the value at request time (sysUpTime, engine-relative clocks).
	fn func() any
}

// MIB is the object tree one agent serves. Build it with the setters, then hand it to Listen; it is
// read-only once served.
type MIB struct {
	byKey   map[string]int
	entries []entry
	sorted  bool
	err     error
}

func NewMIB() *MIB { return &MIB{byKey: map[string]int{}} }

// Err is the first malformed OID or value given to a setter.
func (m *MIB) Err() error { return m.err }

// Len is the number of object instances in the tree.
func (m *MIB) Len() int { return len(m.entries) }

func (m *MIB) set(oid string, typ g.Asn1BER, val any, fn func() any) {
	o, err := ParseOID(oid)
	if err != nil {
		if m.err == nil {
			m.err = err
		}
		return
	}
	key := o.String()
	e := entry{oid: o, typ: typ, val: val, fn: fn}
	if i, ok := m.byKey[key]; ok {
		m.entries[i] = e
		return
	}
	m.byKey[key] = len(m.entries)
	m.entries = append(m.entries, e)
	m.sorted = false
}

// Str sets a DisplayString.
func (m *MIB) Str(oid, v string) { m.set(oid, g.OctetString, []byte(v), nil) }

// Octets sets a binary OCTET STRING (MAC addresses, BITS).
func (m *MIB) Octets(oid string, v []byte) {
	m.set(oid, g.OctetString, append([]byte(nil), v...), nil)
}

// Int sets an INTEGER (Integer32 and enumerations).
func (m *MIB) Int(oid string, v int) { m.set(oid, g.Integer, v, nil) }

func (m *MIB) Gauge(oid string, v uint32)     { m.set(oid, g.Gauge32, v, nil) }
func (m *MIB) Counter(oid string, v uint32)   { m.set(oid, g.Counter32, v, nil) }
func (m *MIB) Counter64(oid string, v uint64) { m.set(oid, g.Counter64, v, nil) }
func (m *MIB) Ticks(oid string, v uint32)     { m.set(oid, g.TimeTicks, v, nil) }

// OID sets an OBJECT IDENTIFIER value.
func (m *MIB) OID(oid, v string) {
	if _, err := ParseOID(v); err != nil {
		if m.err == nil {
			m.err = err
		}
		return
	}
	m.set(oid, g.ObjectIdentifier, "."+strings.TrimPrefix(v, "."), nil)
}

// IP sets an IpAddress (IPv4).
func (m *MIB) IP(oid, v string) { m.set(oid, g.IPAddress, v, nil) }

// TicksFunc sets a TimeTicks object computed when it is read.
func (m *MIB) TicksFunc(oid string, fn func() uint32) {
	m.set(oid, g.TimeTicks, nil, func() any { return fn() })
}

func (m *MIB) freeze() {
	if m.sorted {
		return
	}
	sort.Slice(m.entries, func(i, j int) bool { return Compare(m.entries[i].oid, m.entries[j].oid) < 0 })
	for i, e := range m.entries {
		m.byKey[e.oid.String()] = i
	}
	m.sorted = true
}

func (m *MIB) get(o OID) *entry {
	if i, ok := m.byKey[o.String()]; ok {
		return &m.entries[i]
	}
	return nil
}

// next returns the first instance strictly after o that skip does not reject.
func (m *MIB) next(o OID, skip func(*entry) bool) *entry {
	i := sort.Search(len(m.entries), func(i int) bool { return Compare(m.entries[i].oid, o) > 0 })
	for ; i < len(m.entries); i++ {
		if skip == nil || !skip(&m.entries[i]) {
			return &m.entries[i]
		}
	}
	return nil
}

// objectExists reports whether any instance lives under the object o names minus its last sub-identifier,
// which separates noSuchInstance (the object exists, the instance does not) from noSuchObject.
func (m *MIB) objectExists(o OID) bool {
	if len(o) < 2 {
		return false
	}
	parent := o[:len(o)-1]
	n := m.next(parent, nil)
	return n != nil && n.oid.HasPrefix(parent)
}

func (e *entry) pdu() g.SnmpPDU {
	v := e.val
	if e.fn != nil {
		v = e.fn()
	}
	return g.SnmpPDU{Name: e.oid.String(), Type: e.typ, Value: v}
}

// Index appends instance sub-identifiers to a column OID: integers, dotted strings (IPv4 addresses,
// multi-part indexes) and byte slices (MAC addresses as six sub-identifiers).
func Index(column string, parts ...any) string {
	var b strings.Builder
	b.WriteString(column)
	for _, p := range parts {
		switch v := p.(type) {
		case int:
			b.WriteString("." + strconv.Itoa(v))
		case uint32:
			b.WriteString("." + strconv.FormatUint(uint64(v), 10))
		case string:
			b.WriteString("." + strings.Trim(v, "."))
		case []byte:
			for _, x := range v {
				b.WriteString("." + strconv.Itoa(int(x)))
			}
		default:
			b.WriteString("." + fmt.Sprint(v))
		}
	}
	return b.String()
}
