// REQ-DISC-004 — host agent inventory, the Device42-agent equivalent: the host's identity (hostname,
// fqdn, DMI serial and system UUID, primary MAC), operating system, CPU and memory, network addresses,
// listening TCP services with their owning process, and installed software, gathered from the local
// system without a credential. Linux reads /proc, /sys and the package database; macOS and Windows use
// their platform tools through small, parseable commands. Everything is emitted through the same
// collector contract the agentless families use, so the reconciler needs nothing agent-specific.
package agent

import (
	"bufio"
	"context"
	"encoding/json"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	// Version is the agent build version, reported with every inventory.
	Version = "0.1.0"
	source  = "agent"

	typeHost     = "host"
	typeOS       = "operating_system"
	typeIP       = "ip_address"
	typeListener = "listening_service"
	typeSoftware = "software"
	typeInstance = "software_instance"
	relInstalled = "installed_on"
	relMemberOf  = "member_of"
	relUsesIP    = "uses_ip"
	relRunsOn    = "runs_on"
	defaultVrf   = "default"
	protocolTCP  = "tcp"

	procNetTCP   = "/proc/net/tcp"
	procNetTCP6  = "/proc/net/tcp6"
	procMeminfo  = "/proc/meminfo"
	dmiSerial    = "/sys/class/dmi/id/product_serial"
	dmiUUID      = "/sys/class/dmi/id/product_uuid"
	dmiVendor    = "/sys/class/dmi/id/sys_vendor"
	dmiProduct   = "/sys/class/dmi/id/product_name"
	tcpListen    = "0A"
	hexBase      = 16
	kibPerMib    = 1024
	commandLimit = 30 * time.Second
	// Linux reports listener owners through /proc/<pid>/fd socket inodes; the scan covers every process.
	procRoot = "/proc"
)

// Listener is a TCP socket in LISTEN state with the process that owns it, when it can be resolved.
type Listener struct {
	Address string
	Port    int
	Process string
	PID     int
}

// Package is one installed software package.
type Package struct {
	Name        string
	Version     string
	Vendor      string
	InstallPath string
}

// Inventory is what the agent observed about the host it runs on.
type Inventory struct {
	Hostname     string
	FQDN         string
	Serial       string
	SystemUUID   string
	Manufacturer string
	Model        string
	OSFamily     string
	OSName       string
	OSVersion    string
	Kernel       string
	Architecture string
	CPUs         int
	MemoryMiB    int64
	PrimaryMAC   string
	Addresses    []Address
	Listeners    []Listener
	Packages     []Package
	UptimeSec    int64
	CollectedAt  time.Time
}

// Address is one unicast address on a non-loopback interface.
type Address struct {
	Interface string
	MAC       string
	Address   string
	Prefix    int
}

// osRelease is the distribution identity file every systemd-era Linux ships (os-release(5)).
var osRelease = filepath.Join(string(filepath.Separator), "etc", "os-release")

func readTrim(path string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

// runCommand executes a platform tool with a bounded timeout and returns stdout.
func runCommand(ctx context.Context, name string, args ...string) string {
	ctx, cancel := context.WithTimeout(ctx, commandLimit)
	defer cancel()
	out, err := exec.CommandContext(ctx, name, args...).Output()
	if err != nil {
		return ""
	}
	return string(out)
}

// ParseOSRelease reads the KEY=value file every systemd-era distribution ships.
func ParseOSRelease(text string) (name, version, id string) {
	for _, line := range strings.Split(text, "\n") {
		key, value, ok := strings.Cut(strings.TrimSpace(line), "=")
		if !ok {
			continue
		}
		value = strings.Trim(value, `"`)
		switch key {
		case "NAME":
			name = value
		case "VERSION_ID":
			version = value
		case "ID":
			id = value
		}
	}
	return name, version, id
}

// ParseMeminfo returns MemTotal in MiB.
func ParseMeminfo(text string) int64 {
	for _, line := range strings.Split(text, "\n") {
		if strings.HasPrefix(line, "MemTotal:") {
			fields := strings.Fields(line)
			if len(fields) >= 2 {
				kib, _ := strconv.ParseInt(fields[1], 10, 64)
				return kib / kibPerMib
			}
		}
	}
	return 0
}

// ParseProcNetTCP decodes LISTEN rows of /proc/net/tcp or tcp6 into address, port and socket inode.
func ParseProcNetTCP(text string, ipv6 bool) (map[uint64]Listener, error) {
	out := map[uint64]Listener{}
	scanner := bufio.NewScanner(strings.NewReader(text))
	first := true
	for scanner.Scan() {
		if first {
			first = false
			continue
		}
		fields := strings.Fields(scanner.Text())
		if len(fields) < 10 || fields[3] != tcpListen {
			continue
		}
		hexAddr, hexPort, ok := strings.Cut(fields[1], ":")
		if !ok {
			continue
		}
		port, err := strconv.ParseInt(hexPort, hexBase, 32)
		if err != nil {
			continue
		}
		inode, err := strconv.ParseUint(fields[9], 10, 64)
		if err != nil {
			continue
		}
		out[inode] = Listener{Address: decodeHexAddress(hexAddr, ipv6), Port: int(port)}
	}
	return out, scanner.Err()
}

// decodeHexAddress turns the kernel's little-endian hex address into dotted or colon form.
func decodeHexAddress(h string, ipv6 bool) string {
	if !ipv6 {
		if len(h) != 8 {
			return ""
		}
		var b [4]byte
		for i := 0; i < 4; i++ {
			v, _ := strconv.ParseUint(h[i*2:i*2+2], hexBase, 8)
			b[3-i] = byte(v)
		}
		return net.IP(b[:]).String()
	}
	if len(h) != 32 {
		return ""
	}
	var b [16]byte
	// Four 32-bit words, each little-endian.
	for w := 0; w < 4; w++ {
		for i := 0; i < 4; i++ {
			v, _ := strconv.ParseUint(h[w*8+i*2:w*8+i*2+2], hexBase, 8)
			b[w*4+3-i] = byte(v)
		}
	}
	return net.IP(b[:]).String()
}

// ParseDpkg reads `dpkg-query -W -f '${Package}\t${Version}\t${Maintainer}\n'`.
func ParseDpkg(text string) []Package {
	var out []Package
	for _, line := range strings.Split(text, "\n") {
		fields := strings.Split(strings.TrimSpace(line), "\t")
		if len(fields) < 2 || fields[0] == "" {
			continue
		}
		p := Package{Name: fields[0], Version: fields[1]}
		if len(fields) > 2 {
			p.Vendor = fields[2]
		}
		out = append(out, p)
	}
	return out
}

// ParseRpm reads `rpm -qa --qf '%{NAME}\t%{VERSION}-%{RELEASE}\t%{VENDOR}\n'`.
func ParseRpm(text string) []Package { return ParseDpkg(text) }

// windowsReport is the JSON the PowerShell inventory script prints.
type windowsReport struct {
	ComputerName string `json:"ComputerName"`
	Domain       string `json:"Domain"`
	Manufacturer string `json:"Manufacturer"`
	Model        string `json:"Model"`
	Serial       string `json:"SerialNumber"`
	UUID         string `json:"UUID"`
	Caption      string `json:"Caption"`
	Version      string `json:"Version"`
	BuildNumber  string `json:"BuildNumber"`
	TotalMemory  int64  `json:"TotalPhysicalMemory"`
	Processors   int    `json:"NumberOfLogicalProcessors"`
	LastBoot     string `json:"LastBootUpTime"`
	Listeners    []struct {
		LocalAddress  string `json:"LocalAddress"`
		LocalPort     int    `json:"LocalPort"`
		OwningProcess int    `json:"OwningProcess"`
		ProcessName   string `json:"ProcessName"`
	} `json:"Listeners"`
	Software []struct {
		DisplayName     string `json:"DisplayName"`
		DisplayVersion  string `json:"DisplayVersion"`
		Publisher       string `json:"Publisher"`
		InstallLocation string `json:"InstallLocation"`
	} `json:"Software"`
}

// WindowsScript gathers the Windows inventory as one JSON document.
const WindowsScript = `$ErrorActionPreference = 'SilentlyContinue'
$cs = Get-CimInstance Win32_ComputerSystem
$os = Get-CimInstance Win32_OperatingSystem
$bios = Get-CimInstance Win32_BIOS
$csp = Get-CimInstance Win32_ComputerSystemProduct
$procs = @{}
Get-Process | ForEach-Object { $procs[[int]$_.Id] = $_.ProcessName }
$listeners = Get-NetTCPConnection -State Listen | ForEach-Object { [pscustomobject]@{ LocalAddress = $_.LocalAddress; LocalPort = [int]$_.LocalPort; OwningProcess = [int]$_.OwningProcess; ProcessName = $procs[[int]$_.OwningProcess] } }
$software = @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*') | ForEach-Object { Get-ItemProperty $_ } | Where-Object { $_.DisplayName } | Select-Object DisplayName, DisplayVersion, Publisher, InstallLocation
[pscustomobject]@{
  ComputerName = $cs.Name; Domain = $cs.Domain; Manufacturer = $cs.Manufacturer; Model = $cs.Model
  SerialNumber = $bios.SerialNumber; UUID = $csp.UUID
  Caption = $os.Caption; Version = $os.Version; BuildNumber = $os.BuildNumber
  TotalPhysicalMemory = [int64]$cs.TotalPhysicalMemory; NumberOfLogicalProcessors = [int]$cs.NumberOfLogicalProcessors
  LastBootUpTime = $os.LastBootUpTime.ToString('o')
  Listeners = @($listeners); Software = @($software)
} | ConvertTo-Json -Compress -Depth 4
`

// ParseWindows decodes the WindowsScript output into an inventory (addresses are added by the caller from the OS APIs).
func ParseWindows(text string) (*Inventory, error) {
	var r windowsReport
	if err := json.Unmarshal([]byte(strings.TrimSpace(text)), &r); err != nil {
		return nil, err
	}
	inv := &Inventory{Hostname: r.ComputerName, Serial: r.Serial, SystemUUID: strings.ToLower(r.UUID), Manufacturer: r.Manufacturer, Model: r.Model, OSFamily: "windows", OSName: r.Caption, OSVersion: r.Version + " (build " + r.BuildNumber + ")", CPUs: r.Processors, MemoryMiB: r.TotalMemory / (kibPerMib * kibPerMib)}
	if r.Domain != "" && !strings.EqualFold(r.Domain, "WORKGROUP") {
		inv.FQDN = strings.ToLower(r.ComputerName + "." + r.Domain)
	} else {
		inv.FQDN = strings.ToLower(r.ComputerName)
	}
	if boot, err := time.Parse(time.RFC3339Nano, r.LastBoot); err == nil {
		inv.UptimeSec = int64(time.Since(boot).Seconds())
	}
	for _, l := range r.Listeners {
		inv.Listeners = append(inv.Listeners, Listener{Address: l.LocalAddress, Port: l.LocalPort, PID: l.OwningProcess, Process: l.ProcessName})
	}
	for _, s := range r.Software {
		inv.Packages = append(inv.Packages, Package{Name: s.DisplayName, Version: s.DisplayVersion, Vendor: s.Publisher, InstallPath: s.InstallLocation})
	}
	return inv, nil
}

// collectAddresses lists unicast addresses of non-loopback interfaces and picks the primary MAC.
func collectAddresses() ([]Address, string) {
	ifaces, err := net.Interfaces()
	if err != nil {
		return nil, ""
	}
	var out []Address
	primary := ""
	for _, it := range ifaces {
		if it.Flags&net.FlagLoopback != 0 || it.Flags&net.FlagUp == 0 {
			continue
		}
		addrs, err := it.Addrs()
		if err != nil {
			continue
		}
		mac := strings.ToLower(it.HardwareAddr.String())
		if primary == "" && mac != "" && len(addrs) > 0 {
			primary = mac
		}
		for _, a := range addrs {
			ipNet, ok := a.(*net.IPNet)
			if !ok || ipNet.IP.IsLinkLocalUnicast() {
				continue
			}
			ones, _ := ipNet.Mask.Size()
			out = append(out, Address{Interface: it.Name, MAC: mac, Address: ipNet.IP.String(), Prefix: ones})
		}
	}
	return out, primary
}

// linuxListeners resolves LISTEN sockets to processes through /proc/<pid>/fd.
func linuxListeners() []Listener {
	byInode := map[uint64]Listener{}
	if text := readTrim(procNetTCP); text != "" {
		if rows, err := ParseProcNetTCP(text, false); err == nil {
			for k, v := range rows {
				byInode[k] = v
			}
		}
	}
	if text := readTrim(procNetTCP6); text != "" {
		if rows, err := ParseProcNetTCP(text, true); err == nil {
			for k, v := range rows {
				byInode[k] = v
			}
		}
	}
	if len(byInode) == 0 {
		return nil
	}
	entries, err := os.ReadDir(procRoot)
	if err == nil {
		for _, e := range entries {
			pid, err := strconv.Atoi(e.Name())
			if err != nil {
				continue
			}
			fds, err := os.ReadDir(procRoot + "/" + e.Name() + "/fd")
			if err != nil {
				continue
			}
			for _, fd := range fds {
				link, err := os.Readlink(procRoot + "/" + e.Name() + "/fd/" + fd.Name())
				if err != nil || !strings.HasPrefix(link, "socket:[") {
					continue
				}
				inode, err := strconv.ParseUint(strings.TrimSuffix(strings.TrimPrefix(link, "socket:["), "]"), 10, 64)
				if err != nil {
					continue
				}
				if l, ok := byInode[inode]; ok && l.PID == 0 {
					l.PID = pid
					l.Process = readTrim(procRoot + "/" + e.Name() + "/comm")
					byInode[inode] = l
				}
			}
		}
	}
	out := make([]Listener, 0, len(byInode))
	for _, l := range byInode {
		out = append(out, l)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Port != out[j].Port {
			return out[i].Port < out[j].Port
		}
		return out[i].Address < out[j].Address
	})
	return out
}

// Collect gathers the inventory of the host the agent runs on.
func Collect(ctx context.Context) (*Inventory, error) {
	inv := &Inventory{Architecture: runtime.GOARCH, CPUs: runtime.NumCPU(), CollectedAt: time.Now().UTC()}
	switch runtime.GOOS {
	case "windows":
		out := runCommand(ctx, "powershell.exe", "-NoProfile", "-NonInteractive", "-Command", WindowsScript)
		parsed, err := ParseWindows(out)
		if err != nil {
			return nil, err
		}
		parsed.Architecture = inv.Architecture
		parsed.CollectedAt = inv.CollectedAt
		inv = parsed
	case "darwin":
		host, _ := os.Hostname()
		inv.Hostname = host
		inv.FQDN = strings.ToLower(strings.TrimSpace(runCommand(ctx, "hostname", "-f")))
		inv.OSFamily = "darwin"
		inv.OSName = strings.TrimSpace(runCommand(ctx, "sw_vers", "-productName"))
		inv.OSVersion = strings.TrimSpace(runCommand(ctx, "sw_vers", "-productVersion"))
		inv.Kernel = strings.TrimSpace(runCommand(ctx, "uname", "-r"))
		inv.Serial = strings.TrimSpace(runCommand(ctx, "sh", "-c", "ioreg -l | awk -F'\"' '/IOPlatformSerialNumber/{print $4; exit}'"))
		inv.SystemUUID = strings.ToLower(strings.TrimSpace(runCommand(ctx, "sh", "-c", "ioreg -l | awk -F'\"' '/IOPlatformUUID/{print $4; exit}'")))
		inv.Manufacturer = "Apple"
		inv.Model = strings.TrimSpace(runCommand(ctx, "sysctl", "-n", "hw.model"))
		if mem, err := strconv.ParseInt(strings.TrimSpace(runCommand(ctx, "sysctl", "-n", "hw.memsize")), 10, 64); err == nil {
			inv.MemoryMiB = mem / (kibPerMib * kibPerMib)
		}
		inv.Listeners = ParseLsof(runCommand(ctx, "lsof", "-nP", "-iTCP", "-sTCP:LISTEN"))
		inv.Packages = ParsePkgutil(runCommand(ctx, "pkgutil", "--pkgs-plist"))
	default:
		host, _ := os.Hostname()
		inv.Hostname = host
		inv.FQDN = strings.ToLower(strings.TrimSpace(firstNonEmpty(runCommand(ctx, "hostname", "-f"), host)))
		name, version, id := ParseOSRelease(readTrim(osRelease))
		inv.OSFamily = "linux"
		inv.OSName = firstNonEmpty(name, id, "Linux")
		inv.OSVersion = version
		inv.Kernel = strings.TrimSpace(runCommand(ctx, "uname", "-r"))
		inv.Serial = readTrim(dmiSerial)
		inv.SystemUUID = strings.ToLower(readTrim(dmiUUID))
		inv.Manufacturer = readTrim(dmiVendor)
		inv.Model = readTrim(dmiProduct)
		inv.MemoryMiB = ParseMeminfo(readTrim(procMeminfo))
		if up := strings.Fields(readTrim("/proc/uptime")); len(up) > 0 {
			f, _ := strconv.ParseFloat(up[0], 64)
			inv.UptimeSec = int64(f)
		}
		inv.Listeners = linuxListeners()
		if out := runCommand(ctx, "dpkg-query", "-W", "-f", "${Package}\t${Version}\t${Maintainer}\n"); out != "" {
			inv.Packages = ParseDpkg(out)
		} else if out := runCommand(ctx, "rpm", "-qa", "--qf", "%{NAME}\t%{VERSION}-%{RELEASE}\t%{VENDOR}\n"); out != "" {
			inv.Packages = ParseRpm(out)
		}
	}
	inv.Addresses, inv.PrimaryMAC = collectAddresses()
	return inv, nil
}

// ParseLsof reads `lsof -nP -iTCP -sTCP:LISTEN` rows: COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME(addr:port (LISTEN)).
func ParseLsof(text string) []Listener {
	seen := map[string]bool{}
	var out []Listener
	for i, line := range strings.Split(text, "\n") {
		fields := strings.Fields(line)
		if i == 0 || len(fields) < 9 {
			continue
		}
		name := fields[8]
		idx := strings.LastIndex(name, ":")
		if idx < 0 {
			continue
		}
		port, err := strconv.Atoi(name[idx+1:])
		if err != nil {
			continue
		}
		addr := strings.Trim(name[:idx], "[]")
		pid, _ := strconv.Atoi(fields[1])
		key := addr + ":" + name[idx+1:]
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, Listener{Address: addr, Port: port, PID: pid, Process: fields[0]})
	}
	return out
}

// ParsePkgutil reads the plist-style output of `pkgutil --pkgs-plist` (one <string> per package id).
func ParsePkgutil(text string) []Package {
	var out []Package
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "<string>") && strings.HasSuffix(line, "</string>") {
			id := strings.TrimSuffix(strings.TrimPrefix(line, "<string>"), "</string>")
			out = append(out, Package{Name: id, Vendor: vendorFromReverseDNS(id)})
		}
	}
	return out
}

func vendorFromReverseDNS(id string) string {
	parts := strings.Split(id, ".")
	if len(parts) >= 2 {
		return parts[1]
	}
	return ""
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}
