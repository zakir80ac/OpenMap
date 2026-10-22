// REQ-DISC-007 — parsers for virsh text output (dominfo, domiflist, domblklist, domifaddr,
// guestinfo, nodeinfo, pool-list). Formats are those of libvirt 8–10 as shipped by RHEL 9,
// Ubuntu 22.04/24.04 and Proxmox-hosted qemu; every parser treats missing text as unknown.
package libvirt

import (
	"strconv"
	"strings"
)

// Domain is one libvirt guest as reported by the virsh commands in Script.
type Domain struct {
	UUID       string
	Name       string
	ID         string
	State      string
	OSType     string
	VCPUs      int
	MaxMemKiB  int64
	UsedMemKiB int64
	Autostart  bool
	Persistent bool
	Interfaces []Interface
	Disks      []Disk
	Addresses  []Address
	Guest      map[string]string // guestinfo keys: os.id, os.pretty-name, os.version, os.kernel-release, hostname
}

type Interface struct {
	Name   string
	Type   string
	Source string
	Model  string
	MAC    string
}

type Disk struct {
	Type   string
	Device string
	Target string
	Source string
}

type Address struct {
	Interface string
	MAC       string
	Protocol  string
	Address   string // CIDR as printed by virsh (address slash prefix length)
}

// Node is the hypervisor host as reported by virsh nodeinfo / version / hostname and sysfs DMI.
type Node struct {
	Hostname       string
	FQDN           string
	LibvirtVersion string
	QemuVersion    string
	CPUModel       string
	CPUs           int
	MemoryKiB      int64
	ProductUUID    string
	ProductSerial  string
	Vendor         string
	Product        string
	Pools          []Pool
	Networks       []string
}

type Pool struct {
	Name      string
	State     string
	Capacity  string
	Available string
}

// kv parses "Key:   value" lines into a map keyed by the lower-cased label.
func kv(text string) map[string]string {
	out := map[string]string{}
	for _, line := range strings.Split(text, "\n") {
		i := strings.Index(line, ":")
		if i <= 0 {
			continue
		}
		out[strings.ToLower(strings.TrimSpace(line[:i]))] = strings.TrimSpace(line[i+1:])
	}
	return out
}

func parseInt(s string) int {
	f := strings.Fields(s)
	if len(f) == 0 {
		return 0
	}
	n, _ := strconv.Atoi(f[0])
	return n
}

func parseInt64(s string) int64 {
	f := strings.Fields(s)
	if len(f) == 0 {
		return 0
	}
	n, _ := strconv.ParseInt(f[0], 10, 64)
	return n
}

// ParseDominfo fills the scalar fields of a Domain from `virsh dominfo`.
func ParseDominfo(text string, d *Domain) {
	m := kv(text)
	d.ID = m["id"]
	d.Name = m["name"]
	if u := m["uuid"]; u != "" {
		d.UUID = strings.ToLower(u)
	}
	d.OSType = m["os type"]
	d.State = m["state"]
	d.VCPUs = parseInt(m["cpu(s)"])
	d.MaxMemKiB = parseInt64(m["max memory"])
	d.UsedMemKiB = parseInt64(m["used memory"])
	d.Autostart = strings.EqualFold(m["autostart"], "enable")
	d.Persistent = strings.EqualFold(m["persistent"], "yes")
}

// tableRows skips the header and separator lines of a virsh table and returns field slices.
func tableRows(text string) [][]string {
	var rows [][]string
	seenSep := false
	for _, line := range strings.Split(text, "\n") {
		t := strings.TrimSpace(line)
		if t == "" {
			continue
		}
		if strings.HasPrefix(t, "---") {
			seenSep = true
			continue
		}
		if !seenSep {
			continue
		}
		rows = append(rows, strings.Fields(t))
	}
	return rows
}

// ParseDomiflist parses `virsh domiflist`: Interface Type Source Model MAC.
func ParseDomiflist(text string) []Interface {
	var out []Interface
	for _, f := range tableRows(text) {
		if len(f) < 5 {
			continue
		}
		out = append(out, Interface{Name: f[0], Type: f[1], Source: f[2], Model: f[3], MAC: strings.ToLower(f[4])})
	}
	return out
}

// ParseDomblklist parses `virsh domblklist --details`: Type Device Target Source.
func ParseDomblklist(text string) []Disk {
	var out []Disk
	for _, f := range tableRows(text) {
		if len(f) < 3 {
			continue
		}
		d := Disk{Type: f[0], Device: f[1], Target: f[2]}
		if len(f) > 3 {
			d.Source = strings.Join(f[3:], " ")
		}
		out = append(out, d)
	}
	return out
}

// ParseDomifaddr parses `virsh domifaddr`: Name MAC Protocol Address; continuation rows ("-") inherit.
func ParseDomifaddr(text string) []Address {
	var out []Address
	last := Address{}
	for _, f := range tableRows(text) {
		if len(f) < 4 {
			continue
		}
		a := Address{Interface: f[0], MAC: strings.ToLower(f[1]), Protocol: f[2], Address: f[3]}
		if a.Interface == "-" {
			a.Interface, a.MAC = last.Interface, last.MAC
		}
		if a.MAC == "-" {
			a.MAC = last.MAC
		}
		last = a
		out = append(out, a)
	}
	return out
}

// ParseGuestinfo parses `virsh guestinfo` "key : value" lines.
func ParseGuestinfo(text string) map[string]string {
	m := map[string]string{}
	for k, v := range kv(text) {
		m[k] = v
	}
	return m
}

// ParseNodeinfo parses `virsh nodeinfo`.
func ParseNodeinfo(text string, n *Node) {
	m := kv(text)
	n.CPUModel = m["cpu model"]
	n.CPUs = parseInt(m["cpu(s)"])
	n.MemoryKiB = parseInt64(m["memory size"])
}

// ParseVersion parses `virsh version --daemon`.
func ParseVersion(text string, n *Node) {
	for _, line := range strings.Split(text, "\n") {
		l := strings.TrimSpace(line)
		switch {
		case strings.HasPrefix(l, "Using library:"):
			n.LibvirtVersion = lastField(l)
		case strings.HasPrefix(l, "Running hypervisor:"):
			n.QemuVersion = strings.TrimSpace(strings.TrimPrefix(l, "Running hypervisor:"))
		}
	}
}

func lastField(l string) string {
	f := strings.Fields(l)
	if len(f) == 0 {
		return ""
	}
	return f[len(f)-1]
}

// ParsePoolList parses `virsh pool-list --all --details`.
func ParsePoolList(text string) []Pool {
	var out []Pool
	for _, f := range tableRows(text) {
		if len(f) < 4 {
			continue
		}
		p := Pool{Name: f[0], State: f[1]}
		// Capacity / Allocation / Available each print as "<number> <unit>" when the pool is active.
		if len(f) >= 10 {
			p.Capacity = f[4] + " " + f[5]
			p.Available = f[8] + " " + f[9]
		}
		out = append(out, p)
	}
	return out
}

// ParseNetList parses `virsh net-list --all` names.
func ParseNetList(text string) []string {
	var out []string
	for _, f := range tableRows(text) {
		if len(f) > 0 {
			out = append(out, f[0])
		}
	}
	return out
}

// ParseDmi parses the key=value lines emitted for sysfs DMI ids.
func ParseDmi(text string, n *Node) {
	for _, line := range strings.Split(text, "\n") {
		k, v, ok := strings.Cut(strings.TrimSpace(line), "=")
		if !ok {
			continue
		}
		switch k {
		case "product_uuid":
			n.ProductUUID = strings.ToLower(v)
		case "product_serial":
			n.ProductSerial = v
		case "sys_vendor":
			n.Vendor = v
		case "product_name":
			n.Product = v
		}
	}
}

// BytesOf converts "<number> <unit>" (KiB/MiB/GiB/TiB) into bytes.
func BytesOf(s string) int64 {
	f := strings.Fields(s)
	if len(f) < 2 {
		return 0
	}
	v, err := strconv.ParseFloat(f[0], 64)
	if err != nil {
		return 0
	}
	mult := map[string]float64{"B": 1, "KiB": 1 << 10, "MiB": 1 << 20, "GiB": 1 << 30, "TiB": 1 << 40, "PiB": 1 << 50}[f[1]]
	return int64(v * mult)
}
