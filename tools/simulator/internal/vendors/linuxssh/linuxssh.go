// REQ-QA-005 REQ-DISC-003 — simulated Linux hosts over SSH for the ssh_agentless collector. Each selected estate
// host (bare-metal RHEL and Ubuntu servers) and Linux VM (Nutanix AHV guests, whose SMBIOS UUID is the VM UUID)
// gets its own SSH daemon with a per-server host key. The daemon answers the collector's one delimited script by
// rendering every @@OPENMAP section in the command formats of the recorded transcripts under
// packages/testing/fixtures/vendor/ssh_agentless: hostname/fqdn, os-release, uname, /proc (cpuinfo, meminfo,
// uptime, stat), sysfs DMI, `ip addr` (bond and slaves from the estate cabling), `ss -Hltunp` (the estate's
// listening services on the host plus sshd), rpm/dpkg package rows, lsblk, df and FC HBAs. dmidecode needs root,
// which the simulated login does not have, so DIMMs are not reported (as on a real host). Package rows, disks and
// /proc/stat counters are not in the estate: they come from a fixed per-distribution set below, deterministic per
// host, and the expectations use that same set.
package linuxssh

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net"
	"sort"
	"strconv"
	"strings"

	"github.com/openmap/openmap/tools/simulator/internal/estate"
	"github.com/openmap/openmap/tools/simulator/internal/protocols/sshd"
	"github.com/openmap/openmap/tools/simulator/internal/sim"
)

const (
	osRHEL   = "Red Hat Enterprise Linux"
	osUbuntu = "Ubuntu"
	// hostsPerOS bounds the bare-metal sample per distribution; vmsPerOS the AHV guest sample.
	hostsPerOS = 3
	vmsPerOS   = 1
	kibPerGiB  = 1 << 20
	mtuJumbo   = 9000
	mtuGuest   = 1500
	sshPort    = 22
	sshdPID    = 1187
	// idleShare is the fraction of /proc/stat time a simulated host reports idle (in percent).
	idleShare      = 80
	percent        = 100
	jiffiesPerSec  = 100
	statDeltaJiffy = 400
	rootDiskBytes  = 959656755200
	dataDiskBytes  = 3840755982336
	vmDiskBytes    = 100 << 30
	rootFsKiB      = 73364480
	rootUsedKiB    = 9437184
	ahvPlatform    = "nutanix_ahv"
)

type Vendor struct{}

func (Vendor) ID() string             { return "linux-ssh" }
func (Vendor) Collector() string      { return "ssh_agentless" }
func (Vendor) Requirements() []string { return []string{"REQ-DISC-003"} }

// pkg is one OS package row; interesting marks the ones the collector turns into software CIs.
type pkg struct {
	name, version, arch string
	interesting         bool
}

var packages = map[string][]pkg{
	osRHEL: {
		{"bash", "5.1.8-9.el9", "x86_64", false}, {"chrony", "4.5-1.el9", "x86_64", false}, {"coreutils", "8.32-35.el9", "x86_64", false},
		{"glibc", "2.34-100.el9_4.2", "x86_64", true}, {"openssh-server", "8.7p1-38.el9", "x86_64", true}, {"openssl", "3.0.7-27.el9", "x86_64", true},
		{"python3", "3.9.18-3.el9_4.5", "x86_64", true}, {"sudo", "1.9.5p2-10.el9_3", "x86_64", true}, {"systemd", "252-32.el9_4", "x86_64", true},
	},
	osUbuntu: {
		{"bash", "5.2.21-2ubuntu4", "amd64", false}, {"chrony", "4.5-1ubuntu4.1", "amd64", false}, {"coreutils", "9.4-3ubuntu6", "amd64", false},
		{"libc6", "2.39-0ubuntu8.3", "amd64", true}, {"openssh-server", "1:9.6p1-3ubuntu13.5", "amd64", true}, {"openssl", "3.0.13-0ubuntu3.4", "amd64", true},
		{"python3", "3.12.3-0ubuntu2", "amd64", true}, {"sudo", "1.9.15p5-3ubuntu5", "amd64", true}, {"systemd", "255.4-1ubuntu8.4", "amd64", true},
	},
}

// osRelease renders /etc/os-release for a distribution and VERSION_ID as the vendor ships it.
func osRelease(name, versionID string) (string, string) {
	switch name {
	case osRHEL:
		major, _, _ := strings.Cut(versionID, ".")
		pretty := "Red Hat Enterprise Linux " + versionID + " (Plow)"
		return `NAME="Red Hat Enterprise Linux"
VERSION="` + versionID + ` (Plow)"
ID="rhel"
ID_LIKE="fedora"
VERSION_ID="` + versionID + `"
PLATFORM_ID="platform:el` + major + `"
PRETTY_NAME="` + pretty + `"
ANSI_COLOR="0;31"
LOGO="fedora-logo-icon"
CPE_NAME="cpe:/o:redhat:enterprise_linux:` + versionID + `::baseos"
HOME_URL="https://www.redhat.com/"
REDHAT_SUPPORT_PRODUCT="Red Hat Enterprise Linux"
REDHAT_SUPPORT_PRODUCT_VERSION="` + versionID + `"`, pretty
	default:
		pretty := "Ubuntu " + versionID + " LTS"
		return `PRETTY_NAME="` + pretty + `"
NAME="Ubuntu"
VERSION_ID="` + versionID + `"
VERSION="` + versionID + ` LTS (Noble Numbat)"
VERSION_CODENAME=noble
ID=ubuntu
ID_LIKE=debian
HOME_URL="https://www.ubuntu.com/"
SUPPORT_URL="https://help.ubuntu.com/"
BUG_REPORT_URL="https://bugs.launchpad.net/ubuntu/"
UBUNTU_CODENAME=noble`, pretty
	}
}

// nic is one interface the host shows in `ip addr`.
type nic struct {
	name    string
	mac     string
	master  string
	addrs   []string // CIDR
	speed   int
	slave   bool
	isBond  bool
	isGuest bool
}

// node is one simulated Linux system and what the collector must find on it.
type node struct {
	ci        *estate.CI
	vm        bool
	hostname  string
	fqdn      string
	serial    string
	uuid      string
	vendor    string
	model     string
	bios      string
	osName    string
	osVersion string
	osPretty  string
	osRelease string
	kernel    string
	arch      string
	cpuModel  string
	sockets   int
	cores     int
	memGiB    int
	uptime    int64
	nics      []nic
	ips       []*estate.CI
	listeners []*estate.CI
	osCI      *estate.CI
	server    *sshd.Server
	// key marks the run that authenticates with the ssh_key credential instead of the password.
	key bool
}

func (n *node) hostRef() string {
	if n.serial != "" {
		return n.serial
	}
	return n.uuid
}

func digest(parts ...string) string {
	sum := sha256.Sum256([]byte(strings.Join(parts, "\x00")))
	return hex.EncodeToString(sum[:])
}

func prefixOf(subnet string) string {
	if _, p, ok := strings.Cut(subnet, "/"); ok {
		return p
	}
	return "24"
}

// listenersByRef indexes estate listening services by the host reference the collector computes.
func listenersByRef(e *estate.Estate) map[string][]*estate.CI {
	out := map[string][]*estate.CI{}
	for _, l := range e.OfType("listening_service", nil) {
		out[l.ID("hostRef")] = append(out[l.ID("hostRef")], l)
	}
	return out
}

func osOf(e *estate.Estate, host *estate.CI) *estate.CI {
	for _, o := range e.To(host, "runs_on") {
		if o.Type == "operating_system" {
			return o
		}
	}
	return nil
}

func hostNode(e *estate.Estate, h *estate.CI, ls map[string][]*estate.CI) *node {
	n := &node{ci: h, hostname: h.Str("hostname"), fqdn: h.ID("fqdn"), serial: h.ID("serialNumber"), uuid: strings.ToLower(h.ID("systemUuid")),
		vendor: h.Str("manufacturer"), model: h.Str("model"), bios: h.Str("biosVersion"), osName: h.Str("osName"), osVersion: h.Str("osVersion"),
		cpuModel: h.Str("cpuModel"), sockets: int(h.Num("cpuSockets", 1)), cores: int(h.Num("cpuCores", 1)), memGiB: int(h.Num("memoryGb", 1)),
		uptime: int64(h.Num("uptimeSeconds", 0)), arch: "x86_64"}
	if n.hostname == "" {
		n.hostname = h.Name
	}
	if o := osOf(e, h); o != nil {
		n.osCI = o
		n.kernel = o.Str("kernel")
		if a := o.Str("architecture"); a != "" {
			n.arch = a
		}
	}
	n.ips = e.From(h, "uses_ip")
	bondName := "bond0"
	var addrs []string
	for _, ip := range n.ips {
		addrs = append(addrs, ip.ID("address")+"/"+prefixOf(ip.Str("subnet")))
		if i := ip.Str("interface"); i != "" {
			bondName = i
		}
	}
	mac := strings.ToLower(h.ID("primaryMac"))
	for _, r := range e.Rels {
		if r.Type != "cabled_to" || e.Resolve(r.From) != h {
			continue
		}
		name, _ := r.Attributes["hostNic"].(string)
		speed, _ := r.Attributes["speedMbps"].(float64)
		if name != "" {
			n.nics = append(n.nics, nic{name: name, mac: mac, master: bondName, slave: true, speed: int(speed)})
		}
	}
	sort.Slice(n.nics, func(i, j int) bool { return n.nics[i].name < n.nics[j].name })
	n.nics = append(n.nics, nic{name: bondName, mac: mac, addrs: addrs, isBond: len(n.nics) > 0})
	n.listeners = ls[n.hostRef()]
	return n
}

func vmNode(e *estate.Estate, v *estate.CI, ls map[string][]*estate.CI) *node {
	guest := v.Str("guestOs")
	name, version := osUbuntu, strings.TrimSpace(strings.TrimPrefix(guest, osUbuntu))
	if strings.HasPrefix(guest, osRHEL) {
		name, version = osRHEL, strings.TrimSpace(strings.TrimPrefix(guest, osRHEL))
	}
	n := &node{ci: v, vm: true, hostname: v.Str("hostname"), fqdn: v.ID("fqdn"), uuid: strings.ToLower(v.ID("instanceUuid")),
		vendor: "Nutanix", model: "AHV", osName: name, osVersion: version, cpuModel: "Intel Xeon Processor (Icelake)",
		sockets: int(v.Num("vcpus", 1)), cores: int(v.Num("vcpus", 1)), memGiB: int(v.Num("memoryGb", 1)), arch: "x86_64"}
	if n.hostname == "" {
		n.hostname = v.Name
	}
	n.ips = e.From(v, "uses_ip")
	nicName := "ens3"
	var addrs []string
	for _, ip := range n.ips {
		addrs = append(addrs, ip.ID("address")+"/"+prefixOf(ip.Str("subnet")))
		if i := ip.Str("interface"); i != "" {
			nicName = i
		}
	}
	n.nics = []nic{{name: nicName, mac: strings.ToLower(v.Str("macAddress")), addrs: addrs, isGuest: true}}
	n.listeners = ls[n.hostRef()]
	return n
}

// kernelFor fills a kernel release when the estate has none for the system.
func kernelFor(n *node) string {
	if n.kernel != "" {
		return n.kernel
	}
	if n.osName == osRHEL {
		return "5.14.0-427.37.1.el9_4.x86_64"
	}
	return "6.8.0-45-generic"
}

func selectNodes(e *estate.Estate) []*node {
	ls := listenersByRef(e)
	var out []*node
	for _, osName := range []string{osRHEL, osUbuntu} {
		hosts := e.OfType("host", func(c *estate.CI) bool {
			return c.Str("osName") == osName && c.Str("role") == "bare_metal" && len(e.From(c, "uses_ip")) > 0
		})
		// Hosts the estate knows services on come first, so the listening-service path is exercised.
		sort.SliceStable(hosts, func(i, j int) bool {
			return len(ls[hosts[i].ID("serialNumber")]) > 0 && len(ls[hosts[j].ID("serialNumber")]) == 0
		})
		for i := 0; i < len(hosts) && i < hostsPerOS; i++ {
			out = append(out, hostNode(e, hosts[i], ls))
		}
		vms := e.OfType("vm", func(c *estate.CI) bool {
			return c.Str("platform") == ahvPlatform && strings.HasPrefix(c.Str("guestOs"), osName) && len(e.From(c, "uses_ip")) > 0
		})
		sort.SliceStable(vms, func(i, j int) bool {
			return len(ls[strings.ToLower(vms[i].ID("instanceUuid"))]) > 0 && len(ls[strings.ToLower(vms[j].ID("instanceUuid"))]) == 0
		})
		for i := 0; i < len(vms) && i < vmsPerOS; i++ {
			out = append(out, vmNode(e, vms[i], ls))
		}
	}
	for _, n := range out {
		n.osRelease, n.osPretty = osRelease(n.osName, n.osVersion)
		n.kernel = kernelFor(n)
	}
	if len(out) > 0 {
		out[0].key = true
	}
	return out
}

func (n *node) cpuinfo() string {
	vendorID := "GenuineIntel"
	if strings.Contains(n.cpuModel, "AMD") {
		vendorID = "AuthenticAMD"
	}
	perSocket := n.cores / max(n.sockets, 1)
	var b strings.Builder
	for p := 0; p < n.cores; p++ {
		fmt.Fprintf(&b, "processor\t: %d\nvendor_id\t: %s\ncpu family\t: 6\nmodel name\t: %s\nphysical id\t: %d\nsiblings\t: %d\ncore id\t\t: %d\ncpu cores\t: %d\nflags\t\t: fpu vme de pse tsc msr pae mce cx8 apic sep mtrr pge mca cmov\n\n",
			p, vendorID, n.cpuModel, p/max(perSocket, 1), perSocket, p%max(perSocket, 1), perSocket)
	}
	return strings.TrimRight(b.String(), "\n")
}

func (n *node) memKiB() int64 { return int64(n.memGiB) * kibPerGiB }

func (n *node) dmi() string {
	virt := "none"
	serial := n.serial
	if n.vm {
		virt = "kvm"
	}
	return "product_serial=" + serial + "\nproduct_uuid=" + n.uuid + "\nsys_vendor=" + n.vendor + "\nproduct_name=" + n.model + "\nbios_version=" + n.bios + "\nvirt=" + virt
}

func broadcast(cidr string) string {
	_, ipn, err := net.ParseCIDR(cidr)
	if err != nil {
		return ""
	}
	ip := ipn.IP.To4()
	if ip == nil {
		return ""
	}
	out := make(net.IP, len(ip))
	for i := range ip {
		out[i] = ip[i] | ^ipn.Mask[i]
	}
	return out.String()
}

func linkLocal(mac string) string {
	hw, err := net.ParseMAC(mac)
	if err != nil || len(hw) != 6 {
		return ""
	}
	return fmt.Sprintf("fe80::%02x%02x:%02xff:fe%02x:%02x%02x/64", hw[0]^2, hw[1], hw[2], hw[3], hw[4], hw[5])
}

func (n *node) ipAddr() string {
	var b strings.Builder
	b.WriteString("1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN group default qlen 1000\n" +
		"    link/loopback 00:00:00:00:00:00 brd 00:00:00:00:00:00\n    inet 127.0.0.1/8 scope host lo\n       valid_lft forever preferred_lft forever\n" +
		"    inet6 ::1/128 scope host noprefixroute \n       valid_lft forever preferred_lft forever\n")
	for i, c := range n.nics {
		idx := i + 2
		mtu := mtuJumbo
		if c.isGuest {
			mtu = mtuGuest
		}
		switch {
		case c.slave:
			fmt.Fprintf(&b, "%d: %s: <BROADCAST,MULTICAST,SLAVE,UP,LOWER_UP> mtu %d qdisc mq master %s state UP group default qlen 1000\n    link/ether %s brd ff:ff:ff:ff:ff:ff\n", idx, c.name, mtu, c.master, c.mac)
			continue
		case c.isBond:
			fmt.Fprintf(&b, "%d: %s: <BROADCAST,MULTICAST,MASTER,UP,LOWER_UP> mtu %d qdisc noqueue state UP group default qlen 1000\n    link/ether %s brd ff:ff:ff:ff:ff:ff\n", idx, c.name, mtu, c.mac)
		default:
			fmt.Fprintf(&b, "%d: %s: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu %d qdisc fq_codel state UP group default qlen 1000\n    link/ether %s brd ff:ff:ff:ff:ff:ff\n    altname enp0s3\n", idx, c.name, mtu, c.mac)
		}
		for _, a := range c.addrs {
			fmt.Fprintf(&b, "    inet %s brd %s scope global noprefixroute %s\n       valid_lft forever preferred_lft forever\n", a, broadcast(a), c.name)
		}
		if ll := linkLocal(c.mac); ll != "" {
			fmt.Fprintf(&b, "    inet6 %s scope link noprefixroute \n       valid_lft forever preferred_lft forever\n", ll)
		}
	}
	return strings.TrimRight(b.String(), "\n")
}

// sockets are the listeners `ss -Hltunp` prints: the estate's services on this system, sshd (the collector is
// logged in through it) and chronyd's loopback command socket.
type socket struct {
	proto, addr, process string
	port, pid            int
}

func (n *node) openSockets() []socket {
	var out []socket
	have := map[string]bool{}
	for _, l := range n.listeners {
		addr := l.Str("bindAddress")
		if addr == "" {
			addr = "0.0.0.0"
		}
		s := socket{proto: l.ID("protocol"), addr: addr, process: l.Str("process"), port: int(l.Num("port", 0)), pid: int(l.Num("pid", 0))}
		have[s.proto+"/"+strconv.Itoa(s.port)] = true
		out = append(out, s)
	}
	if !have["tcp/"+strconv.Itoa(sshPort)] {
		out = append(out, socket{proto: "tcp", addr: "0.0.0.0", process: "sshd", port: sshPort, pid: sshdPID})
	}
	return out
}

func (n *node) ss() string {
	var b strings.Builder
	b.WriteString("udp   UNCONN 0      0          127.0.0.1:323        0.0.0.0:*    users:((\"chronyd\",pid=912,fd=5))\n")
	for _, s := range n.openSockets() {
		state, recvQ, sendQ := "LISTEN", "0", "4096"
		if s.proto == "udp" {
			state, sendQ = "UNCONN", "0"
		}
		fmt.Fprintf(&b, "%-5s %-6s %-6s %-6s %s:%d 0.0.0.0:* users:((\"%s\",pid=%d,fd=3))\n", s.proto, state, recvQ, sendQ, s.addr, s.port, s.process, s.pid)
		if s.process == "sshd" {
			fmt.Fprintf(&b, "tcp   LISTEN 0      128            [::]:%d       [::]:*    users:((\"sshd\",pid=%d,fd=4))\n", s.port, s.pid)
		}
	}
	return strings.TrimRight(b.String(), "\n")
}

func (n *node) packages() []pkg { return packages[n.osName] }

func (n *node) packageRows() string {
	rows := make([]string, 0, len(n.packages())+1)
	for _, p := range n.packages() {
		rows = append(rows, p.name+"\t"+p.version+"\t"+p.arch)
	}
	if n.osName == osRHEL {
		rows = append(rows, "kernel\t"+strings.TrimSuffix(n.kernel, "."+n.arch)+"\t"+n.arch)
	}
	return strings.Join(rows, "\n")
}

func (n *node) diskModel() string {
	switch {
	case n.vm:
		return "VDISK"
	case strings.HasPrefix(n.vendor, "Dell"):
		return "PERC H755 Front"
	case strings.HasPrefix(n.vendor, "Hewlett"):
		return "LOGICAL VOLUME"
	default:
		return "RAID 940-8i"
	}
}

func (n *node) diskSerial() string { return strings.ToUpper(digest("disk", n.hostRef())[:16]) }

func (n *node) lsblk() string {
	if n.vm {
		return "sda 100G disk " + n.diskModel()
	}
	return "sda 893.8G disk " + n.diskModel() + "\nsdb   3.5T disk " + n.diskModel()
}

func (n *node) lsblkPairs() string {
	line := func(name string, size int64) string {
		return fmt.Sprintf(`NAME="%s" SIZE="%d" TYPE="disk" MODEL="%s" SERIAL="%s" VENDOR="%s" ROTA="0" TRAN="%s" REV="5.2"`, name, size, n.diskModel(), n.diskSerial()+name, firstWord(n.vendor), map[bool]string{true: "", false: "sas"}[n.vm])
	}
	if n.vm {
		return line("sda", vmDiskBytes)
	}
	return line("sda", rootDiskBytes) + "\n" + line("sdb", dataDiskBytes)
}

func firstWord(s string) string {
	if f := strings.Fields(s); len(f) > 0 {
		return f[0]
	}
	return s
}

func (n *node) df() string {
	root := "/dev/mapper/rhel-root"
	if n.osName == osUbuntu {
		root = "/dev/mapper/ubuntu--vg-ubuntu--lv"
	}
	return "Filesystem     1024-blocks      Used Available Capacity Mounted on\n" +
		fmt.Sprintf("%s %d %d %d %d%% /\n", root, rootFsKiB, rootUsedKiB, rootFsKiB-rootUsedKiB, rootUsedKiB*percent/rootFsKiB) +
		"/dev/sda2          983040    262144    720896      27% /boot"
}

func (n *node) nicsSys() string {
	var rows []string
	for _, c := range n.nics {
		if c.isBond {
			continue
		}
		speed := c.speed
		driver := "i40e"
		if c.isGuest {
			speed, driver = -1, "virtio_net"
		}
		rows = append(rows, c.name+"\t"+c.mac+"\t"+strconv.Itoa(speed)+"\t"+driver)
	}
	return strings.Join(rows, "\n")
}

func (n *node) cpuStat() string {
	total := n.uptime*jiffiesPerSec*int64(max(n.cores, 1)) + 1
	idle := total * idleShare / percent
	user := total - idle
	line := func(u, i int64) string { return fmt.Sprintf("cpu  %d 120 %d %d 4120 0 913 0 0 0", u*3/4, u/4, i) }
	return line(user, idle) + "\n" + line(user+statDeltaJiffy/4, idle+statDeltaJiffy*3/4)
}

func (n *node) memAvailable() string {
	total := n.memKiB()
	return fmt.Sprintf("MemTotal:       %d kB\nMemAvailable:   %d kB", total, total*idleShare/percent)
}

// section renders one @@OPENMAP key; keys the simulator does not know print nothing, as `|| true` would.
func (n *node) section(key string) string {
	switch key {
	case "hostname":
		return n.hostname
	case "fqdn":
		return n.fqdn
	case "machine_id":
		return digest("machine-id", n.hostRef())[:32]
	case "os_release":
		return n.osRelease
	case "kernel":
		return n.kernel
	case "arch":
		return n.arch
	case "uptime":
		return fmt.Sprintf("%d.42 %d.17", n.uptime, n.uptime*int64(max(n.cores, 1))*idleShare/percent)
	case "cpuinfo":
		return n.cpuinfo()
	case "meminfo":
		return fmt.Sprintf("MemTotal:       %d kB", n.memKiB())
	case "dmi":
		return n.dmi()
	case "ip_addr":
		return n.ipAddr()
	case "ss":
		return n.ss()
	case "packages":
		return n.packageRows()
	case "lsblk":
		return n.lsblk()
	case "df":
		return n.df()
	case "lsblk_pairs":
		return n.lsblkPairs()
	case "nics":
		return n.nicsSys()
	case "cpu_stat":
		return n.cpuStat()
	case "mem_available":
		return n.memAvailable()
	default:
		return ""
	}
}

func (n *node) render(script string) string {
	var b strings.Builder
	for _, s := range sshd.Sections(script) {
		b.WriteString(sshd.Frame(s.Key, n.section(s.Key)))
	}
	return b.String()
}

func (Vendor) Start(_ context.Context, e *estate.Estate, env *sim.Env) (*sim.Endpoint, error) {
	nodes := selectNodes(e)
	privPEM, pub, err := sshd.ClientKey()
	if err != nil {
		return nil, err
	}
	ep := &sim.Endpoint{Host: sim.AdvertiseHost(), State: map[string]any{"nodes": nodes, "clientKey": privPEM}}
	for _, n := range nodes {
		srv, err := sshd.Serve(env, sshd.Shell(n.render), sshd.Config{AuthorizedKey: pub})
		if err != nil {
			_ = ep.Close()
			return nil, err
		}
		n.server = srv
		ep.OnClose(srv.Close)
	}
	return ep, nil
}

func (Vendor) Runs(_ *estate.Estate, ep *sim.Endpoint, env *sim.Env) []sim.Run {
	nodes, _ := ep.State["nodes"].([]*node)
	privPEM, _ := ep.State["clientKey"].(string)
	var runs []sim.Run
	for _, n := range nodes {
		cred := sshd.PasswordCredential(env)
		if n.key {
			cred = sshd.KeyCredential(env, privPEM)
		}
		run := sim.Run{Name: n.hostname, Targets: []sim.Target{n.server.Target(n.hostname)}, Options: n.server.Options(), CredentialType: cred.Type, Credential: cred}
		n.expect(&run.Expect)
		runs = append(runs, run)
	}
	return runs
}

// expect lists what the collector must emit. Names follow the collector (it names a host by FQDN, an OS by its
// os-release PRETTY_NAME, a service by its process); identities are the estate's, so the harness reports drift.
func (n *node) expect(x *sim.Expect) {
	hostType := "host"
	if n.vm {
		hostType = "vm"
	}
	x.CIs = append(x.CIs, sim.ExpectCI{Type: hostType, Name: n.fqdn, Identity: n.ci.Identity})
	osIdentity := map[string]string{"hostRef": n.hostRef(), "family": "linux", "version": n.osVersion}
	if n.osCI != nil {
		osIdentity = n.osCI.Identity
	}
	x.CIs = append(x.CIs, sim.ExpectCI{Type: "operating_system", Name: n.osPretty, Identity: osIdentity})
	x.Rel("runs_on", "operating_system", n.osPretty, hostType, n.fqdn)
	for _, c := range n.nics {
		x.CI("interface", c.name)
		x.Rel("contains", hostType, n.fqdn, "interface", c.name)
	}
	ipIface := n.nics[len(n.nics)-1].name
	for _, ip := range n.ips {
		x.CIs = append(x.CIs, sim.ExpectCI{Type: "ip_address", Name: ip.ID("address"), Identity: ip.Identity})
		x.Rel("uses_ip", "interface", ipIface, "ip_address", ip.ID("address"))
	}
	byKey := map[string]*estate.CI{}
	for _, l := range n.listeners {
		byKey[l.ID("protocol")+"/"+l.ID("port")] = l
	}
	for _, s := range n.openSockets() {
		ci := sim.ExpectCI{Type: "listening_service", Name: s.process}
		if l, ok := byKey[s.proto+"/"+strconv.Itoa(s.port)]; ok {
			ci.Identity = l.Identity
		}
		x.CIs = append(x.CIs, ci)
		x.Rel("runs_on", "listening_service", s.process, hostType, n.fqdn)
	}
	for _, p := range n.packages() {
		if !p.interesting {
			continue
		}
		x.CI("software", p.name+" "+p.version)
		x.CI("software_instance", p.name+" on "+n.fqdn)
		x.Rel("installed_on", "software_instance", p.name+" on "+n.fqdn, hostType, n.fqdn)
	}
}
