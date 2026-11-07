// REQ-QA-005 REQ-DISC-002 — simulated Windows Server hosts behind WinRM for the wmi collector. Every estate host
// whose operating system is Windows answers the collector's inventory script on its own loopback address with the
// document the script's CIM/WMI and NetTCPIP cmdlets would print through ConvertTo-Json: computer system, BIOS,
// product, OS, processors, adapters, addresses, listeners, processes, uninstall entries, services, hotfixes,
// logical and physical disks, memory modules, Fibre Channel ports, utilisation, FQDN and installed features.
//
// From the estate: names, FQDN, serial, UUID, vendor and model, sockets, cores, CPU model, memory, BIOS version,
// primary MAC and IP (prefix from its subnet), host-side NIC cabling and speed, OS build and patch date, installed
// agents (vendor, version, install path and date), listening services and HBA WWPNs from fabric zoning. Seeded per
// host (no randomness between runs), because the estate does not describe them: disk layout and sizes, DIMM and
// drive part data, adapter descriptions and driver versions, process ids, the hotfix id, the CPU and memory load.
package windows

import (
	"context"
	"strconv"
	"strings"
	"time"

	"github.com/openmap/openmap/tools/simulator/internal/estate"
	"github.com/openmap/openmap/tools/simulator/internal/protocols/winrm"
	"github.com/openmap/openmap/tools/simulator/internal/sim"
)

const (
	family         = "windows"
	signature      = "Win32_ComputerSystem"
	signatureNics  = "Get-NetAdapter"
	defaultBuild   = "10.0.20348"
	bytesPerGiB    = 1 << 30
	bytesPerKiB    = 1 << 10
	threadsPerCore = 2
	ifIndexBase    = 12
	loopbackIndex  = 1
	prefixV6LL     = 64
	prefixLoop     = 8
	familyV4       = 2
	familyV6       = 23
	originManual   = 1
	originWell     = 2
	operUp         = 1
	pidSystem      = 4
	pidBase        = 600
	pidSpan        = 60000
	domainMember   = 3
	dimmGiB        = 64
	smallDimmGiB   = 32
	dimmSplitGiB   = 256
	dimmSpeed      = 4800
	bootDriveGiB   = 480
	dataDriveMin   = 960
	dataDriveMax   = 7680
	systemVolGiB   = 200
	freeMinPct     = 15
	freeMaxPct     = 80
	loadMin        = 2
	loadMax        = 65
	memUsedMin     = 25
	memUsedMax     = 85
	percent        = 100
	clockMin       = 2000
	clockMax       = 3800
	clockStep      = 100
	mbitPerGbit    = 1000
	jobTimeoutMs   = 600000
	// reference is the instant the estate was observed (2026-10-01T00:00:00Z): boot times are reference − uptime.
	reference = 1790812800
	estateDay = "2006-01-02"
)

type Vendor struct{}

func (Vendor) ID() string             { return "windows-wmi" }
func (Vendor) Collector() string      { return "wmi" }
func (Vendor) Requirements() []string { return []string{"REQ-DISC-002"} }

// Host is one simulated Windows server and the estate CIs it is rendered from.
type Host struct {
	CI       *estate.CI
	OS       *estate.CI
	IP       *estate.CI
	Software []*estate.CI
	Listen   []*estate.CI
	Cables   []*estate.Rel
	WWPNs    []string
}

// FQDN is the host's DNS name in lower case.
func (h *Host) FQDN() string {
	return strings.ToLower(firstNonEmpty(h.CI.ID("fqdn"), h.CI.Str("fqdn"), h.CI.Name))
}

// Hosts lists every estate host running Windows, in estate order, with what the renderer needs.
func Hosts(e *estate.Estate) []*Host {
	cables := map[*estate.CI][]*estate.Rel{}
	wwpns := map[*estate.CI][]string{}
	for _, r := range e.Rels {
		if r.From.Type != "host" {
			continue
		}
		switch r.Type {
		case "cabled_to":
			if h := e.Resolve(r.From); h != nil {
				cables[h] = append(cables[h], r)
			}
		case "zoned_with":
			if w, ok := r.Attributes["hostWwpn"].(string); ok {
				if h := e.Resolve(r.From); h != nil && !contains(wwpns[h], w) {
					wwpns[h] = append(wwpns[h], w)
				}
			}
		}
	}
	listeners := map[string][]*estate.CI{}
	for _, l := range e.OfType("listening_service", nil) {
		listeners[l.ID("hostRef")] = append(listeners[l.ID("hostRef")], l)
	}
	var out []*Host
	for _, c := range e.OfType("host", nil) {
		var os *estate.CI
		for _, o := range e.To(c, "runs_on") {
			if o.Type == "operating_system" && o.Str("family") == family {
				os = o
			}
		}
		if os == nil {
			continue
		}
		h := &Host{CI: c, OS: os, Cables: cables[c], WWPNs: wwpns[c], Listen: listeners[c.ID("serialNumber")]}
		for _, ip := range e.From(c, "uses_ip") {
			if ip.Type == "ip_address" && h.IP == nil {
				h.IP = ip
			}
		}
		for _, s := range e.To(c, "installed_on") {
			if s.Type == "software_instance" {
				h.Software = append(h.Software, s)
			}
		}
		out = append(out, h)
	}
	return out
}

func contains(list []string, v string) bool {
	for _, s := range list {
		if s == v {
			return true
		}
	}
	return false
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

// OSSoftware is the estate's OS install record (category os) when present.
func (h *Host) OSSoftware() *estate.CI {
	for _, s := range h.Software {
		if s.Str("category") == "os" {
			return s
		}
	}
	return nil
}

// Caption is Win32_OperatingSystem.Caption, e.g. "Microsoft Windows Server 2022 Datacenter".
func (h *Host) Caption() string {
	edition := "Standard"
	if s := h.OSSoftware(); s != nil {
		if f := strings.Fields(s.Str("name")); len(f) > 0 {
			edition = f[len(f)-1]
		}
	}
	return "Microsoft Windows Server " + firstNonEmpty(h.OS.Str("version"), h.CI.Str("osVersion")) + " " + edition
}

// Build is the kernel version Win32_OperatingSystem.Version reports.
func (h *Host) Build() string { return firstNonEmpty(h.OS.Str("kernel"), defaultBuild) }

// Apps are the uninstall-registry entries (every estate install except the OS itself).
func (h *Host) Apps() []*estate.CI {
	var out []*estate.CI
	for _, s := range h.Software {
		if s.Str("category") != "os" {
			out = append(out, s)
		}
	}
	return out
}

// Domain is the DNS suffix of the host's FQDN.
func (h *Host) Domain() string {
	f := h.FQDN()
	if i := strings.Index(f, "."); i >= 0 {
		return f[i+1:]
	}
	return "WORKGROUP"
}

// Prefix is the primary address's prefix length from its estate subnet.
func (h *Host) Prefix() int {
	if h.IP == nil {
		return 0
	}
	if _, bits, ok := strings.Cut(h.IP.Str("subnet"), "/"); ok {
		if n, err := strconv.Atoi(bits); err == nil {
			return n
		}
	}
	return 0
}

// Nic is one adapter the host reports.
type Nic struct {
	Name, Description, MAC, Speed, Driver string
	Index                                 int
}

func dashMac(mac string) string { return strings.ToUpper(strings.ReplaceAll(mac, ":", "-")) }

func nextMac(mac string, n int) string {
	parts := strings.Split(mac, ":")
	if len(parts) != 6 {
		return mac
	}
	last, err := strconv.ParseUint(parts[5], 16, 8)
	if err != nil {
		return mac
	}
	parts[5] = strconv.FormatUint((last+uint64(n))%(1<<8), 16)
	if len(parts[5]) == 1 {
		parts[5] = "0" + parts[5]
	}
	return strings.Join(parts, ":")
}

var adapters = []string{"Intel(R) Ethernet Controller X710 for 10GbE SFP+", "Broadcom NetXtreme E-Series Advanced Dual-port 25Gb SFP28", "Mellanox ConnectX-5 Adapter", "Intel(R) Ethernet Network Adapter E810-XXV-2"}

// Nics are the cabled host ports (at least one), the first carrying the primary MAC.
func (h *Host) Nics() []Nic {
	n := len(h.Cables)
	if n == 0 {
		n = 1
	}
	desc := adapters[winrm.Pick(0, len(adapters)-1, h.CI.ID("serialNumber"), "nic")]
	out := make([]Nic, 0, n)
	for i := 0; i < n; i++ {
		name := "Ethernet"
		if i > 0 {
			name = "Ethernet " + strconv.Itoa(i+1)
		}
		if i < len(h.Cables) {
			if hn, ok := h.Cables[i].Attributes["hostNic"].(string); ok && hn != "" && i == 0 {
				name = hn
			}
		}
		speed := "10 Gbps"
		if i < len(h.Cables) {
			if mbps, ok := h.Cables[i].Attributes["speedMbps"].(float64); ok && mbps > 0 {
				speed = strconv.FormatFloat(mbps/mbitPerGbit, 'f', -1, 64) + " Gbps"
			}
		}
		d := desc
		if i > 0 {
			d += " #" + strconv.Itoa(i+1)
		}
		out = append(out, Nic{Name: name, Description: d, MAC: nextMac(strings.ToLower(h.CI.Str("primaryMac")), i), Speed: speed, Index: ifIndexBase + i,
			Driver: strconv.Itoa(winrm.Pick(1, 3, h.CI.Name, "drv")) + "." + strconv.Itoa(winrm.Pick(0, 40, h.CI.Name, "drv2")) + ".0.0"})
	}
	return out
}

// Listener is one listening socket the host reports.
type Listener struct {
	Proto, Process, Path string
	Port, PID            int
}

func pid(h *Host, name string) int {
	return pidBase + winrm.Pick(0, pidSpan, h.CI.Name, name)*pidSystem
}

// Listeners are the Windows Server defaults plus the estate's listening services on this host.
func (h *Host) Listeners() []Listener {
	svchost := `C:\Windows\System32\svchost.exe`
	out := []Listener{
		{Proto: "tcp", Port: 135, Process: "svchost", Path: svchost, PID: pid(h, "rpcss")},
		{Proto: "tcp", Port: 445, Process: "System", PID: pidSystem},
		{Proto: "tcp", Port: 3389, Process: "svchost", Path: svchost, PID: pid(h, "termservice")},
		{Proto: "tcp", Port: 5985, Process: "System", PID: pidSystem},
		{Proto: "tcp", Port: 5986, Process: "System", PID: pidSystem},
		{Proto: "udp", Port: 123, Process: "svchost", Path: svchost, PID: pid(h, "w32time")},
	}
	for _, l := range h.Listen {
		port := int(l.Num("port", 0))
		if port == 0 {
			continue
		}
		proc := firstNonEmpty(l.Str("process"), "unknown")
		out = append(out, Listener{Proto: firstNonEmpty(l.Str("protocol"), "tcp"), Port: port, Process: proc, Path: `C:\Program Files\` + proc + `\` + proc + `.exe`, PID: int(l.Num("pid", float64(pid(h, proc))))})
	}
	return out
}

// ListenerName is the collector's listening_service name for a socket.
func ListenerName(l Listener) string { return l.Proto + "/" + strconv.Itoa(l.Port) + " " + l.Process }

func day(s string) time.Time {
	if len(s) >= len(estateDay) {
		if t, err := time.Parse(estateDay, s[:len(estateDay)]); err == nil {
			return t
		}
	}
	return time.Unix(reference, 0).UTC()
}

// linkLocal is a stable fe80::/64 address with the interface zone, as Get-NetIPAddress prints it.
func linkLocal(serial string, index int) string {
	g := strings.ToLower(strings.ReplaceAll(winrm.GUID(serial, "ll", strconv.Itoa(index)), "-", ""))
	return "fe80::" + g[0:4] + ":" + g[4:8] + ":" + g[8:12] + ":" + g[12:16] + "%" + strconv.Itoa(index)
}

func cpuVendor(model string) string {
	if strings.Contains(strings.ToLower(model), "amd") {
		return "AuthenticAMD"
	}
	return "GenuineIntel"
}

var dimmMakers = []string{"Samsung", "SK Hynix", "Micron Technology"}

// Inventory renders the document the collector's script prints for the host.
func (h *Host) Inventory() map[string]any {
	c := h.CI
	serial := c.ID("serialNumber")
	sockets := int(c.Num("cpuSockets", 1))
	cores := int(c.Num("cpuCores", 1))
	memBytes := int64(c.Num("memoryGb", 0)) * bytesPerGiB
	memKiB := memBytes / bytesPerKiB
	hostname := firstNonEmpty(c.Str("hostname"), strings.SplitN(h.FQDN(), ".", 2)[0])
	osInstall := time.Unix(reference, 0).UTC()
	if s := h.OSSoftware(); s != nil {
		osInstall = day(s.Str("installedAt"))
	}
	boot := time.Unix(reference-int64(c.Num("uptimeSeconds", 0)), 0).UTC()
	cpus := []any{}
	perSocket := cores / max(sockets, 1)
	clock := winrm.Pick(clockMin/clockStep, clockMax/clockStep, serial, "clock") * clockStep
	for i := 0; i < sockets; i++ {
		cpus = append(cpus, map[string]any{"DeviceID": "CPU" + strconv.Itoa(i), "SocketDesignation": "CPU" + strconv.Itoa(i+1), "Name": c.Str("cpuModel"), "Manufacturer": cpuVendor(c.Str("cpuModel")),
			"NumberOfCores": perSocket, "NumberOfLogicalProcessors": perSocket * threadsPerCore, "MaxClockSpeed": clock})
	}
	nicDocs, ipDocs := []any{}, []any{}
	for _, n := range h.Nics() {
		nicDocs = append(nicDocs, map[string]any{"Name": n.Name, "InterfaceDescription": n.Description, "InterfaceIndex": n.Index, "MacAddress": dashMac(n.MAC), "LinkSpeed": n.Speed,
			"Status": "Up", "ifOperStatus": operUp, "HardwareInterface": true, "DriverVersion": n.Driver})
		ipDocs = append(ipDocs, map[string]any{"InterfaceIndex": n.Index, "IPAddress": linkLocal(serial, n.Index), "PrefixLength": prefixV6LL, "AddressFamily": familyV6, "PrefixOrigin": originWell})
	}
	if h.IP != nil {
		ipDocs = append([]any{map[string]any{"InterfaceIndex": ifIndexBase, "IPAddress": h.IP.ID("address"), "PrefixLength": h.Prefix(), "AddressFamily": familyV4, "PrefixOrigin": originManual}}, ipDocs...)
	}
	ipDocs = append(ipDocs, map[string]any{"InterfaceIndex": loopbackIndex, "IPAddress": "127.0.0.1", "PrefixLength": prefixLoop, "AddressFamily": familyV4, "PrefixOrigin": originWell})
	tcp, udp := []any{}, []any{}
	procs := []any{map[string]any{"Id": 0, "ProcessName": "Idle", "Path": nil}, map[string]any{"Id": pidSystem, "ProcessName": "System", "Path": nil}}
	seenPid := map[int]bool{0: true, pidSystem: true}
	for _, l := range h.Listeners() {
		doc := map[string]any{"LocalAddress": "0.0.0.0", "LocalPort": l.Port, "OwningProcess": l.PID}
		if l.Proto == "udp" {
			udp = append(udp, doc)
		} else {
			tcp = append(tcp, doc, map[string]any{"LocalAddress": "::", "LocalPort": l.Port, "OwningProcess": l.PID})
		}
		if !seenPid[l.PID] {
			seenPid[l.PID] = true
			var path any
			if l.Path != "" {
				path = l.Path
			}
			procs = append(procs, map[string]any{"Id": l.PID, "ProcessName": l.Process, "Path": path})
		}
	}
	sw := []any{}
	services := []any{
		map[string]any{"Name": "LanmanServer", "DisplayName": "Server", "State": "Running", "StartMode": "Auto", "PathName": `C:\Windows\system32\svchost.exe -k netsvcs -p`, "StartName": "LocalSystem"},
		map[string]any{"Name": "TermService", "DisplayName": "Remote Desktop Services", "State": "Running", "StartMode": "Manual", "PathName": `C:\Windows\System32\svchost.exe -k NetworkService`, "StartName": `NT Authority\NetworkService`},
		map[string]any{"Name": "WinRM", "DisplayName": "Windows Remote Management (WS-Management)", "State": "Running", "StartMode": "Auto", "PathName": `C:\Windows\System32\svchost.exe -k NetworkService -p`, "StartName": `NT AUTHORITY\NetworkService`},
		map[string]any{"Name": "Spooler", "DisplayName": "Print Spooler", "State": "Stopped", "StartMode": "Disabled", "PathName": `C:\Windows\System32\spoolsv.exe`, "StartName": "LocalSystem"},
	}
	for _, s := range h.Apps() {
		sw = append(sw, map[string]any{"DisplayName": s.Str("name"), "DisplayVersion": s.Str("version"), "Publisher": s.Str("vendor"), "InstallDate": day(s.Str("installedAt")).Format("20060102"), "InstallLocation": s.Str("installPath")})
		state := "Stopped"
		if s.Bool("running") {
			state = "Running"
		}
		services = append(services, map[string]any{"Name": strings.ReplaceAll(s.Str("name"), " ", ""), "DisplayName": s.Str("name"), "State": state, "StartMode": "Auto", "PathName": s.Str("installPath"), "StartName": "LocalSystem"})
	}
	patched := day(h.OS.Str("lastPatchedAt"))
	hotfixes := []any{map[string]any{"HotFixID": "KB50" + strconv.Itoa(winrm.Pick(10000, 49999, serial, patched.Format(estateDay))), "Description": "Security Update", "InstalledOn": winrm.Date(patched)}}
	dataGiB := winrm.Pick(dataDriveMin/dataDriveMin, dataDriveMax/dataDriveMin, serial, "data") * dataDriveMin
	disks := []any{
		map[string]any{"DeviceID": "C:", "Size": int64(systemVolGiB) * bytesPerGiB, "FreeSpace": int64(systemVolGiB) * bytesPerGiB * int64(winrm.Pick(freeMinPct, freeMaxPct, serial, "c")) / percent, "FileSystem": "NTFS", "VolumeName": ""},
		map[string]any{"DeviceID": "D:", "Size": int64(dataGiB) * bytesPerGiB, "FreeSpace": int64(dataGiB) * bytesPerGiB * int64(winrm.Pick(freeMinPct, freeMaxPct, serial, "d")) / percent, "FileSystem": "NTFS", "VolumeName": "Data"},
	}
	dimm := dimmGiB
	if c.Num("memoryGb", 0) < dimmSplitGiB {
		dimm = smallDimmGiB
	}
	memory := []any{}
	maker := dimmMakers[winrm.Pick(0, len(dimmMakers)-1, serial, "dimm")]
	for i := 0; i < int(c.Num("memoryGb", 0))/dimm; i++ {
		memory = append(memory, map[string]any{"BankLabel": "", "DeviceLocator": "DIMM " + string(rune('A'+i%(1<<3))) + strconv.Itoa(i/(1<<3)+1), "Capacity": int64(dimm) * bytesPerGiB,
			"Manufacturer": maker, "SerialNumber": strings.ToUpper(winrm.GUID(serial, "dimm", strconv.Itoa(i))[:8]), "PartNumber": "M321R" + strconv.Itoa(dimm/smallDimmGiB*4) + "GA0BB0-CQK", "ConfiguredClockSpeed": dimmSpeed})
	}
	drives := []any{
		map[string]any{"Index": 0, "Model": "BOSS-N1 Monolithic", "SerialNumber": strings.ToUpper(winrm.GUID(serial, "boot")[:16]), "Size": int64(bootDriveGiB) * bytesPerGiB, "FirmwareRevision": "2.1.13", "InterfaceType": "SCSI", "MediaType": "Fixed hard disk media"},
		map[string]any{"Index": 1, "Model": "PERC H755 Front Virtual Disk", "SerialNumber": strings.ToUpper(winrm.GUID(serial, "data")[:16]), "Size": int64(dataGiB) * bytesPerGiB, "FirmwareRevision": "5.2", "InterfaceType": "SCSI", "MediaType": "Fixed hard disk media"},
	}
	hbas := []any{}
	for i, w := range h.WWPNs {
		port := strings.ReplaceAll(w, ":", "")
		hbas = append(hbas, map[string]any{"InstanceName": `PCI\VEN_10DF&DEV_F400\` + strconv.Itoa(i) + "_0", "PortAddress": port, "NodeAddress": "20" + port[2:], "OperationalStatus": []int{2}})
	}
	features := []string{"FileAndStorage-Services", "Storage-Services", "PowerShellRoot", "PowerShell", "WoW64-Support"}
	switch {
	case c.Str("role") == "hypervisor":
		features = append(features, "Hyper-V", "Failover-Clustering", "RSAT-Clustering-PowerShell")
	case strings.Contains(c.Name, "-file-"):
		features = append(features, "FS-FileServer", "FS-DFS-Namespace")
	}
	load := float64(winrm.Pick(loadMin, loadMax, serial, "cpu"))
	freeKiB := memKiB * int64(percent-winrm.Pick(memUsedMin, memUsedMax, serial, "mem")) / percent
	return map[string]any{
		"computer": map[string]any{"Name": winrm.NetBIOS(hostname), "Domain": h.Domain(), "Manufacturer": c.Str("manufacturer"), "Model": c.Str("model"), "TotalPhysicalMemory": memBytes,
			"NumberOfProcessors": sockets, "NumberOfLogicalProcessors": cores * threadsPerCore, "HypervisorPresent": c.Str("role") == "hypervisor", "DomainRole": domainMember, "PartOfDomain": true},
		"bios":    map[string]any{"SerialNumber": serial, "SMBIOSBIOSVersion": c.Str("biosVersion"), "Manufacturer": c.Str("manufacturer"), "ReleaseDate": winrm.Date(day(c.Str("purchaseDate")))},
		"product": map[string]any{"UUID": strings.ToUpper(c.ID("systemUuid")), "IdentifyingNumber": serial, "Vendor": c.Str("manufacturer"), "Name": c.Str("model")},
		"os": map[string]any{"Caption": h.Caption(), "Version": h.Build(), "BuildNumber": h.Build()[strings.LastIndex(h.Build(), ".")+1:], "OSArchitecture": "64-bit", "InstallDate": winrm.Date(osInstall),
			"LastBootUpTime": winrm.Date(boot), "ServicePackMajorVersion": 0, "TotalVisibleMemorySize": memKiB, "FreePhysicalMemory": freeKiB},
		"cpu": cpus, "nics": nicDocs, "ips": ipDocs, "tcp": tcp, "udp": udp, "processes": procs, "software": sw, "services": services, "hotfixes": hotfixes,
		"disks": disks, "memory": memory, "drives": drives, "hbas": hbas, "cpuLoad": load, "fqdn": h.FQDN(), "features": features,
	}
}

// Script answers the collector's inventory script on the host.
func (h *Host) Script(script string) winrm.Output {
	if !strings.Contains(script, signature) || !strings.Contains(script, signatureNics) {
		return winrm.Unsupported(winrm.FirstCmdlet(script))
	}
	return winrm.Output{Stdout: winrm.JSON(h.Inventory())}
}

func (Vendor) Start(_ context.Context, e *estate.Estate, env *sim.Env) (*sim.Endpoint, error) {
	hosts := Hosts(e)
	keys := make([]string, len(hosts))
	byKey := map[string]*Host{}
	for i, h := range hosts {
		keys[i] = h.FQDN()
		byKey[keys[i]] = h
	}
	return winrm.Serve(env, keys, func(k string) winrm.Script { return byKey[k].Script })
}

// Options are the job options every WinRM simulator run uses: Basic over HTTPS, verified against the CA.
func Options(env *sim.Env, port int) map[string]any {
	return map[string]any{"auth": "basic", "useTls": true, "verifyTls": true, "caCertPem": env.CA.PEM, "tlsServerName": winrm.ServerName(), "port": port}
}

// Credential is the simulated WinRM account.
func Credential(env *sim.Env) *sim.Credential {
	return &sim.Credential{Type: "password", Fields: map[string]string{"username": env.User, "password": env.Secret}}
}

// Plan turns per-host expectations into runs, one per WinRM job (winrm.Jobs): each target is the host's address,
// extra options are added to the WinRM ones and expect adds what the collector must emit for one host.
func Plan(name string, ep *sim.Endpoint, env *sim.Env, keys []string, extra map[string]any, timeoutMs int, expect func(x *sim.Expect, key string)) []sim.Run {
	jobs := winrm.Jobs(ep, keys)
	runs := make([]sim.Run, 0, len(jobs))
	for _, j := range jobs {
		options := Options(env, j.Port)
		for k, v := range extra {
			options[k] = v
		}
		run := sim.Run{Name: name, Options: options, CredentialType: "password", Credential: Credential(env), TimeoutMs: timeoutMs}
		if len(jobs) > 1 {
			run.Name = name + "/" + j.Keys[0]
		}
		for _, k := range j.Keys {
			run.Targets = append(run.Targets, sim.Target{Kind: "host", Value: ep.Devices[k], Label: k})
			expect(&run.Expect, k)
		}
		runs = append(runs, run)
	}
	return runs
}

func (Vendor) Runs(e *estate.Estate, ep *sim.Endpoint, env *sim.Env) []sim.Run {
	hosts := Hosts(e)
	keys := make([]string, len(hosts))
	byKey := map[string]*Host{}
	for i, h := range hosts {
		keys[i] = h.FQDN()
		byKey[keys[i]] = h
	}
	return Plan("windows-servers", ep, env, keys, nil, jobTimeoutMs, func(x *sim.Expect, fqdn string) {
		h := byKey[fqdn]
		x.CIs = append(x.CIs, sim.ExpectCI{Type: "host", Name: fqdn, Identity: h.CI.Identity})
		x.CIs = append(x.CIs, sim.ExpectCI{Type: "operating_system", Name: h.Caption(), Identity: h.OS.Identity})
		x.Rel("installed_on", "operating_system", h.Caption(), "host", fqdn)
		for _, n := range h.Nics() {
			x.CI("interface", n.Name)
			x.Rel("contains", "host", fqdn, "interface", n.Name)
		}
		if h.IP != nil {
			addr := h.IP.ID("address")
			x.CIs = append(x.CIs, sim.ExpectCI{Type: "ip_address", Name: addr, Identity: h.IP.Identity})
			x.Rel("uses_ip", "interface", h.Nics()[0].Name, "ip_address", addr)
		}
		estateListener := map[string]*estate.CI{}
		for _, l := range h.Listen {
			estateListener[firstNonEmpty(l.Str("protocol"), "tcp")+"/"+l.ID("port")] = l
		}
		for _, l := range h.Listeners() {
			name := ListenerName(l)
			want := sim.ExpectCI{Type: "listening_service", Name: name}
			if el, ok := estateListener[l.Proto+"/"+strconv.Itoa(l.Port)]; ok {
				want.Identity = el.Identity
			}
			x.CIs = append(x.CIs, want)
			x.Rel("runs_on", "listening_service", name, "host", fqdn)
		}
		for _, s := range h.Apps() {
			inst := s.Str("name") + " on " + fqdn
			sw := strings.TrimSpace(s.Str("name") + " " + s.Str("version"))
			x.CIs = append(x.CIs, sim.ExpectCI{Type: "software_instance", Name: inst, Identity: s.Identity})
			swWant := sim.ExpectCI{Type: "software", Name: sw}
			for _, m := range e.From(s, "member_of") {
				if m.Type == "software" {
					swWant.Identity = m.Identity
				}
			}
			x.CIs = append(x.CIs, swWant)
			x.Rel("hosted_on", "software_instance", inst, "host", fqdn)
			x.Rel("installed_on", "software", sw, "software_instance", inst)
		}
	})
}
