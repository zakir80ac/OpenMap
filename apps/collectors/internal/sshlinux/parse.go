// REQ-DISC-003 — parsers for the command outputs the agentless SSH collector gathers from Linux hosts.
// Pure functions over text so recorded transcripts drive the tests.
package sshlinux

import (
	"bufio"
	"regexp"
	"strconv"
	"strings"

	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

// Facts is the parsed view of one host.
type Facts struct {
	Hostname     string
	FQDN         string
	MachineID    string
	ProductUUID  string
	Serial       string
	Manufacturer string
	Model        string
	BIOSVersion  string
	Virtual      string // "", "kvm", "vmware", "microsoft", "xen", "oracle", "docker", "lxc"
	OS           OSRelease
	Kernel       string
	Arch         string
	CPUCount     int
	CPUModel     string
	MemoryKB     int64
	Uptime       float64
	Interfaces   []NetInterface
	Listeners    []Listener
	Packages     []Package
	Disks        []Disk
	Mounts       []Mount
	// Parts inside the host (REQ-CMDB-014, ADR-037).
	Components []contract.Component
	// Utilisation measured during the visit (REQ-CMDB-034).
	Utilisation Utilisation
}

type OSRelease struct {
	ID        string
	Name      string
	Version   string
	VersionID string
	Pretty    string
}

type NetInterface struct {
	Name  string
	MAC   string
	State string
	MTU   int
	Addrs []string // CIDR notation
}

type Listener struct {
	Proto   string
	Address string
	Port    int
	Process string
	PID     int
}

type Package struct {
	Name    string
	Version string
	Arch    string
}

type Disk struct {
	Name  string
	Size  string
	Type  string
	Model string
}

type Mount struct {
	Device string
	Path   string
	FSType string
	SizeKB int64
	UsedKB int64
}

// ParseOSRelease parses /etc/os-release key=value lines.
func ParseOSRelease(text string) OSRelease {
	var o OSRelease
	for _, line := range strings.Split(text, "\n") {
		k, v, ok := strings.Cut(strings.TrimSpace(line), "=")
		if !ok {
			continue
		}
		v = strings.Trim(v, `"'`)
		switch k {
		case "ID":
			o.ID = v
		case "NAME":
			o.Name = v
		case "VERSION":
			o.Version = v
		case "VERSION_ID":
			o.VersionID = v
		case "PRETTY_NAME":
			o.Pretty = v
		}
	}
	return o
}

var ipLinkHeader = regexp.MustCompile(`^(\d+):\s+([^:@]+)(?:@[^:]+)?:\s+<([^>]*)>.*?mtu\s+(\d+)`)
var ipLinkEther = regexp.MustCompile(`link/ether\s+([0-9a-f:]{17})`)
var ipInet = regexp.MustCompile(`^\s*inet6?\s+([0-9a-fA-F:.]+/\d+)`)

// ParseIPAddr parses `ip -o addr` is awkward across distros; we parse `ip addr` multi-line output.
func ParseIPAddr(text string) []NetInterface {
	var out []NetInterface
	var cur *NetInterface
	for _, line := range strings.Split(text, "\n") {
		if m := ipLinkHeader.FindStringSubmatch(line); m != nil {
			if cur != nil {
				out = append(out, *cur)
			}
			mtu, _ := strconv.Atoi(m[4])
			state := "down"
			if strings.Contains(m[3], "UP") && !strings.Contains(m[3], "NO-CARRIER") {
				state = "up"
			}
			cur = &NetInterface{Name: m[2], State: state, MTU: mtu}
			continue
		}
		if cur == nil {
			continue
		}
		if m := ipLinkEther.FindStringSubmatch(line); m != nil {
			cur.MAC = m[1]
		}
		if m := ipInet.FindStringSubmatch(line); m != nil {
			cur.Addrs = append(cur.Addrs, m[1])
		}
	}
	if cur != nil {
		out = append(out, *cur)
	}
	filtered := out[:0]
	for _, i := range out {
		if i.Name == "lo" {
			continue
		}
		filtered = append(filtered, i)
	}
	return filtered
}

var ssUsers = regexp.MustCompile(`users:\(\("([^"]+)",pid=(\d+)`)

// ParseSS parses `ss -Hltunp` (no header, listening, tcp+udp, numeric, processes).
func ParseSS(text string) []Listener {
	var out []Listener
	seen := map[string]bool{}
	for _, line := range strings.Split(text, "\n") {
		f := strings.Fields(line)
		if len(f) < 5 {
			continue
		}
		proto := f[0]
		local := f[4]
		if proto == "tcp" && f[1] != "LISTEN" {
			continue
		}
		idx := strings.LastIndex(local, ":")
		if idx < 0 {
			continue
		}
		port, err := strconv.Atoi(local[idx+1:])
		if err != nil {
			continue
		}
		addr := strings.Trim(local[:idx], "[]")
		if addr == "*" || addr == "" {
			addr = "0.0.0.0"
		}
		l := Listener{Proto: proto, Address: addr, Port: port}
		if m := ssUsers.FindStringSubmatch(line); m != nil {
			l.Process = m[1]
			l.PID, _ = strconv.Atoi(m[2])
		}
		key := proto + "/" + addr + "/" + strconv.Itoa(port)
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, l)
	}
	return out
}

// ParsePackages parses `dpkg-query -W -f='${Package}\t${Version}\t${Architecture}\n'` or
// `rpm -qa --qf '%{NAME}\t%{VERSION}-%{RELEASE}\t%{ARCH}\n'`: both are three tab-separated columns.
func ParsePackages(text string) []Package {
	var out []Package
	sc := bufio.NewScanner(strings.NewReader(text))
	for sc.Scan() {
		f := strings.Split(sc.Text(), "\t")
		if len(f) < 2 || f[0] == "" {
			continue
		}
		p := Package{Name: f[0], Version: f[1]}
		if len(f) > 2 {
			p.Arch = f[2]
		}
		out = append(out, p)
	}
	return out
}

// ParseLsblk parses `lsblk -dn -o NAME,SIZE,TYPE,MODEL`.
func ParseLsblk(text string) []Disk {
	var out []Disk
	for _, line := range strings.Split(text, "\n") {
		f := strings.Fields(line)
		if len(f) < 3 || f[2] != "disk" {
			continue
		}
		d := Disk{Name: f[0], Size: f[1], Type: f[2]}
		if len(f) > 3 {
			d.Model = strings.Join(f[3:], " ")
		}
		out = append(out, d)
	}
	return out
}

// ParseDF parses `df -kP -x tmpfs -x devtmpfs -x squashfs`.
func ParseDF(text string) []Mount {
	var out []Mount
	for i, line := range strings.Split(text, "\n") {
		if i == 0 {
			continue
		}
		f := strings.Fields(line)
		if len(f) < 6 {
			continue
		}
		size, _ := strconv.ParseInt(f[1], 10, 64)
		used, _ := strconv.ParseInt(f[2], 10, 64)
		out = append(out, Mount{Device: f[0], Path: f[5], SizeKB: size, UsedKB: used})
	}
	return out
}

// ParseMeminfo returns MemTotal in KB.
func ParseMeminfo(text string) int64 {
	for _, line := range strings.Split(text, "\n") {
		if strings.HasPrefix(line, "MemTotal:") {
			f := strings.Fields(line)
			if len(f) >= 2 {
				n, _ := strconv.ParseInt(f[1], 10, 64)
				return n
			}
		}
	}
	return 0
}

// ParseCPUInfo returns the logical CPU count and model name.
func ParseCPUInfo(text string) (int, string) {
	count := 0
	model := ""
	for _, line := range strings.Split(text, "\n") {
		if strings.HasPrefix(line, "processor") {
			count++
		}
		if model == "" && strings.HasPrefix(line, "model name") {
			if _, v, ok := strings.Cut(line, ":"); ok {
				model = strings.TrimSpace(v)
			}
		}
	}
	return count, model
}

// ParseUptime parses /proc/uptime (seconds).
func ParseUptime(text string) float64 {
	f := strings.Fields(text)
	if len(f) == 0 {
		return 0
	}
	v, _ := strconv.ParseFloat(f[0], 64)
	return v
}

// ParseDMI reads the key=value block produced by the collector's dmi command (see commands.go).
func ParseDMI(text string, f *Facts) {
	for _, line := range strings.Split(text, "\n") {
		k, v, ok := strings.Cut(strings.TrimSpace(line), "=")
		if !ok {
			continue
		}
		v = strings.TrimSpace(v)
		if v == "" || strings.EqualFold(v, "To Be Filled By O.E.M.") || strings.EqualFold(v, "Not Specified") {
			continue
		}
		switch k {
		case "product_serial":
			f.Serial = v
		case "product_uuid":
			f.ProductUUID = strings.ToLower(v)
		case "sys_vendor":
			f.Manufacturer = v
		case "product_name":
			f.Model = v
		case "bios_version":
			f.BIOSVersion = v
		case "virt":
			if v != "none" {
				f.Virtual = v
			}
		}
	}
}
