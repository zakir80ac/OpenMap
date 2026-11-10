// T-300 REQ-DISC-003 — recorded vendor fixtures: raw stdout of Script() captured over SSH by the real
// ssh_agentless collector from Ubuntu, Debian, AlmaLinux, Alpine and Amazon Linux (container lab,
// packages/testing/fixtures/vendor/ssh_agentless). Split, Assemble, Components (REQ-CMDB-014),
// MeasureUtilisation (REQ-CMDB-034) and Emit run over each capture.
package sshlinux

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"sort"
	"testing"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

const fixtureRoot = "../../../../packages/testing/fixtures/vendor/ssh_agentless"

// Facts shared by every capture: all five containers ran on one WSL2 kernel host.
const (
	fixtureCPUModel = "AMD Ryzen AI 9 HX 370 w/ Radeon 890M"
	// The host disk is 66.57% full; every container's fullest df entry is a view of it.
	fixtureDiskPercent = 66.5746
	// Expectations were computed independently from the transcripts to four decimals.
	utilisationTolerance = 0.001
)

// WSL2 virtual disks as lsblk -b reports them (bytes).
var wslDiskBytes = map[string]float64{"sda": 407490560, "sdb": 195080192, "sdc": 4294971392, "sdd": 1099511627776, "sde": 147886080, "sdf": 1099511627776}

type fixtureExpect struct {
	hostname    string
	osID        string
	osVersionID string
	osPretty    string
	osName      string
	hostType    string
	virtual     string
	machineID   string
	mac         string
	ip          string
	cidr        string
	packages    int
	software    []string // interesting packages that become software CIs, sorted "name version"
	disks       int
	mounts      int
	listeners   int // parsed sockets (before loopback/duplicate filtering)
	services    []string
	// REQ-CMDB-014 parts and REQ-CMDB-034 utilisation, as the capture gives them.
	diskParts  int     // whole disks from lsblk -P (BusyBox Alpine has no lsblk)
	cpuPercent float64 // busy share between the two recorded /proc/stat reads
	memPercent float64 // (MemTotal - MemAvailable) / MemTotal
	diskMount  string  // fullest filesystem in df
	// Captures taken before a section joined Script() lack it; the parsers treat it as unknown.
	predates []string
	// Per-capture host disk facts where they differ from the first five captures' shared host state.
	diskPercent float64
	disksBytes  map[string]float64
	// REQ-IPAM-005: firewall rules (with base chain policies), sets, and rule-to-set references links.
	firewallRules, firewallObjects, firewallLinks int
}

// Sections added to Script() after the first five captures (2026-11-06).
var afterFirstCaptures = []string{"nft"}

var fixtureExpectations = map[string]fixtureExpect{
	// REQ-IPAM-005: a Debian 12 host with nftables, sudo allowed `nft -j list ruleset` (2026-11-10). Without
	// systemd-detect-virt the container reports no virtualisation, so it is a host; WSL had re-ordered two virtual disks.
	"debian-debian-12-nftables": {
		hostname: "lab-fw-debian12", osID: "debian", osVersionID: "12", osPretty: "Debian GNU/Linux 12 (bookworm)", osName: "Debian GNU/Linux",
		hostType: typeHost, virtual: "unknown", machineID: "", mac: "82:a8:e6:28:6d:c9", ip: "192.168.112.2", cidr: "192.168.112.2/20",
		packages: 122, disks: 6, mounts: 1, listeners: 4, services: []string{"tcp/22"},
		software:  []string{"libc6 2.36-9+deb12u14", "openssh-server 1:9.2p1-2+deb12u10", "sudo 1.9.13p3-1+deb12u4"},
		diskParts: 6, cpuPercent: 61.5894, memPercent: 45.3034, diskMount: "/etc/hosts",
		diskPercent: 27.4581, disksBytes: map[string]float64{"sda": 407490560, "sdb": 195080192, "sdc": 4294971392, "sdd": 147886080, "sde": 1099511627776, "sdf": 1099511627776},
		firewallRules: 21, firewallObjects: 3, firewallLinks: 3,
	},
	"canonical-ubuntu-24.04.5": {
		hostname: "lab-ubuntu2404", osID: "ubuntu", osVersionID: "24.04", osPretty: "Ubuntu 24.04.5 LTS", osName: "Ubuntu",
		hostType: typeVM, virtual: "wsl", machineID: "921f16fc20de4b42831e333e08f4fd45", mac: "e6:44:02:c8:bd:2c", ip: "192.168.112.2", cidr: "192.168.112.2/20",
		packages: 197, disks: 6, mounts: 1, listeners: 6, services: []string{"tcp/22", "tcp/80"},
		software:  []string{"libc6 2.39-0ubuntu8.9", "nginx 1.24.0-2ubuntu7.19", "openssh-server 1:9.6p1-3ubuntu13.20", "openssl 3.0.13-0ubuntu3.16", "python3 3.12.3-0ubuntu2.1", "systemd 255.4-1ubuntu8.18"},
		diskParts: 6, cpuPercent: 14.6650, memPercent: 38.6656, diskMount: "/etc/hosts", predates: afterFirstCaptures,
	},
	"debian-debian-12": {
		hostname: "lab-debian12", osID: "debian", osVersionID: "12", osPretty: "Debian GNU/Linux 12 (bookworm)", osName: "Debian GNU/Linux",
		hostType: typeVM, virtual: "wsl", machineID: "699a9e04c4c046178c55fb4190ee0f1d", mac: "e2:65:22:77:30:ca", ip: "192.168.112.3", cidr: "192.168.112.3/20",
		packages: 157, disks: 6, mounts: 1, listeners: 6, services: []string{"tcp/22", "tcp/80"},
		software:  []string{"libc6 2.36-9+deb12u14", "nginx 1.22.1-9+deb12u10", "openssh-server 1:9.2p1-2+deb12u10", "openssl 3.0.22-1~deb12u2", "systemd 252.39-1~deb12u2"},
		diskParts: 6, cpuPercent: 21.5013, memPercent: 38.2705, diskMount: "/etc/hosts", predates: afterFirstCaptures,
	},
	"almalinux-almalinux-9.8": {
		hostname: "lab-alma9", osID: "almalinux", osVersionID: "9.8", osPretty: "AlmaLinux 9.8 (Olive Jaguar)", osName: "AlmaLinux",
		hostType: typeVM, virtual: "wsl", machineID: "", mac: "82:5a:ec:bc:dc:d5", ip: "192.168.112.4", cidr: "192.168.112.4/20",
		packages: 171, disks: 6, mounts: 1, listeners: 6, services: []string{"tcp/22", "tcp/80"},
		software:  []string{"glibc 2.34-283.el9_8", "nginx 1.20.1-28.el9_8.6.alma.1", "openssh-server 9.9p1-13.el9_8.alma.1", "openssl 3.5.8-2.el9_8", "python3 3.9.25-7.el9_8.6", "systemd 252-67.el9_8.6.alma.1"},
		diskParts: 6, cpuPercent: 15.9091, memPercent: 38.4133, diskMount: "/etc/hosts", predates: afterFirstCaptures,
	},
	"alpine-alpine-3.20.10": {
		hostname: "lab-alpine320", osID: "alpine", osVersionID: "3.20.10", osPretty: "Alpine Linux v3.20", osName: "Alpine Linux",
		hostType: typeHost, virtual: "unknown", machineID: "", mac: "fe:16:52:e6:23:51", ip: "192.168.112.5", cidr: "192.168.112.5/20",
		packages: 27, disks: 0, mounts: 14, listeners: 6, services: []string{"tcp/22", "tcp/80"},
		software:  []string{"nginx 1.26.3-r0", "openssh-server 9.7_p1-r6", "openssl 3.3.7-r0"},
		diskParts: 0, cpuPercent: 12.3426, memPercent: 38.6841, diskMount: "/", predates: afterFirstCaptures,
	},
	"aws-amazonlinux-2023.12.20261102": {
		hostname: "lab-al2023", osID: "amzn", osVersionID: "2023", osPretty: "Amazon Linux 2023.12.20261102", osName: "Amazon Linux",
		hostType: typeVM, virtual: "wsl", machineID: "014034a2f64043d0b07247d6f678b526", mac: "da:ad:f8:bb:8d:6d", ip: "192.168.112.6", cidr: "192.168.112.6/20",
		packages: 165, disks: 6, mounts: 1, listeners: 6, services: []string{"tcp/22", "tcp/80"},
		software:  []string{"glibc 2.34-231.amzn2023.0.5", "nginx 1.30.6-1.amzn2023.0.1", "openssh-server 9.9p1-16.amzn2023.0.1", "openssl 3.5.8-1.amzn2023.0.3", "python3 3.9.25-1.amzn2023.0.11", "systemd 252.23-15.amzn2023"},
		diskParts: 6, cpuPercent: 16.3546, memPercent: 39.5075, diskMount: "/etc/hosts", predates: afterFirstCaptures,
	},
}

func TestREQDISC003_T300_RecordedVendorFixtures(t *testing.T) {
	entries, err := os.ReadDir(fixtureRoot)
	if err != nil {
		t.Fatalf("fixture dir: %v", err)
	}
	seen := 0
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		seen++
		dir := e.Name()
		t.Run(dir, func(t *testing.T) {
			want, ok := fixtureExpectations[dir]
			if !ok {
				t.Fatalf("fixture %s has no expectation row", dir)
			}
			var manifest struct {
				Family string `json:"family"`
				Req    string `json:"req"`
				Files  []struct {
					Name string `json:"name"`
				} `json:"files"`
			}
			mb, err := os.ReadFile(filepath.Join(fixtureRoot, dir, "manifest.json"))
			if err != nil {
				t.Fatal(err)
			}
			if err := json.Unmarshal(mb, &manifest); err != nil || manifest.Family != "ssh_agentless" || manifest.Req != "REQ-DISC-003" || len(manifest.Files) == 0 {
				t.Fatalf("manifest: %v %+v", err, manifest)
			}
			raw, err := os.ReadFile(filepath.Join(fixtureRoot, dir, "transcript.txt"))
			if err != nil {
				t.Fatal(err)
			}
			parts := Split(string(raw))
			for _, c := range Commands {
				if _, ok := parts[c.Key]; !ok && !containsString(want.predates, c.Key) {
					t.Errorf("section %s missing from the transcript", c.Key)
				}
			}
			diskPercent, disksBytes := fixtureDiskPercent, wslDiskBytes
			if want.diskPercent > 0 {
				diskPercent, disksBytes = want.diskPercent, want.disksBytes
			}
			f := Assemble(parts)
			if f.Hostname != want.hostname || f.FQDN != want.hostname || f.MachineID != want.machineID {
				t.Errorf("identity facts: %q %q %q", f.Hostname, f.FQDN, f.MachineID)
			}
			if f.OS.ID != want.osID || f.OS.VersionID != want.osVersionID || f.OS.Pretty != want.osPretty || f.OS.Name != want.osName {
				t.Errorf("os-release: %+v", f.OS)
			}
			if f.Kernel != "6.6.87.2-microsoft-standard-WSL2" || f.Arch != "x86_64" || f.CPUCount != 8 || f.CPUModel != "AMD Ryzen AI 9 HX 370 w/ Radeon 890M" || f.MemoryKB != 24611036 || f.Uptime <= 0 {
				t.Errorf("platform facts: %q %q %d %q %d %v", f.Kernel, f.Arch, f.CPUCount, f.CPUModel, f.MemoryKB, f.Uptime)
			}
			if f.Virtual != want.virtual || f.Serial != "" || f.ProductUUID != "" {
				t.Errorf("dmi: virt=%q serial=%q uuid=%q", f.Virtual, f.Serial, f.ProductUUID)
			}
			if len(f.Interfaces) != 1 || f.Interfaces[0].Name != "eth0" || f.Interfaces[0].MAC != want.mac || f.Interfaces[0].State != "up" || f.Interfaces[0].MTU != 1500 || len(f.Interfaces[0].Addrs) != 1 || f.Interfaces[0].Addrs[0] != want.cidr {
				t.Errorf("interfaces: %+v", f.Interfaces)
			}
			if len(f.Packages) != want.packages || len(f.Disks) != want.disks || len(f.Mounts) != want.mounts || len(f.Listeners) != want.listeners {
				t.Errorf("counts: packages=%d disks=%d mounts=%d listeners=%d", len(f.Packages), len(f.Disks), len(f.Mounts), len(f.Listeners))
			}
			for _, d := range f.Disks {
				if d.Type != "disk" || d.Model != "Virtual Disk" {
					t.Errorf("disk %+v", d)
				}
			}

			// REQ-CMDB-014 — the parts a container login sees: one CPU socket (physical id 0, 8 threads,
			// 4 cores as WSL2 reports), the WSL2 virtual disks from lsblk -P (loop devices are not parts),
			// no NIC parts (eth0 is a veth without a backing device), no FC HBAs and no memory modules
			// (dmidecode is absent / needs root).
			comps := Components(parts)
			kinds := map[string][]contract.Component{}
			for _, c := range comps {
				kinds[c.Kind] = append(kinds[c.Kind], c)
			}
			cpus := kinds[contract.ComponentCPU]
			if len(cpus) != 1 || cpus[0].Slot != "0" || cpus[0].Model != fixtureCPUModel || cpus[0].Manufacturer != "AuthenticAMD" || cpus[0].Details["threads"] != 8 || cpus[0].Details["cores"] != 4 {
				t.Errorf("cpu sockets %+v", cpus)
			}
			diskParts := kinds[contract.ComponentDisk]
			if len(diskParts) != want.diskParts {
				t.Errorf("disk parts %d want %d: %+v", len(diskParts), want.diskParts, diskParts)
			}
			for _, d := range diskParts {
				capacity, known := disksBytes[d.Slot]
				if !known || d.CapacityBytes != capacity || d.Model != "Virtual Disk" || d.Manufacturer != "Msft" || d.Firmware != "1.0" || d.SerialNumber != "" || d.Details["media"] != "hdd" {
					t.Errorf("disk part %+v", d)
				}
			}
			if len(kinds[contract.ComponentNIC]) != 0 || len(kinds[contract.ComponentHBA]) != 0 || len(kinds[contract.ComponentMemory]) != 0 || len(comps) != 1+want.diskParts {
				t.Errorf("components %+v", comps)
			}

			// REQ-CMDB-034 — utilisation from the two /proc/stat reads, MemAvailable and the fullest df mount.
			u := MeasureUtilisation(parts, f.Mounts)
			if math.Abs(u.CPUPercent-want.cpuPercent) > utilisationTolerance || math.Abs(u.MemoryPercent-want.memPercent) > utilisationTolerance || math.Abs(u.DiskPercent-diskPercent) > utilisationTolerance || u.DiskMount != want.diskMount {
				t.Errorf("utilisation %+v", u)
			}

			at := time.Date(2026, 11, 6, 20, 56, 0, 0, time.UTC)
			obs := Emit(f, contract.Target{Kind: "host", Value: "127.0.0.1"}, raw, at)
			if len(obs.Evidence) != 1 || string(obs.Evidence[0].Data) != string(raw) {
				t.Errorf("evidence must carry the raw transcript")
			}
			byType := map[string][]contract.ObservedCi{}
			for _, ci := range obs.Cis {
				byType[ci.Type] = append(byType[ci.Type], ci)
			}
			hosts := byType[want.hostType]
			if len(hosts) != 1 || hosts[0].Name != want.hostname {
				t.Fatalf("host CI (%s): %+v", want.hostType, hosts)
			}
			host := hosts[0]
			if host.Identity["fqdn"] != want.hostname {
				t.Errorf("host identity %v", host.Identity)
			}
			if want.hostType == typeVM && host.Identity["hypervisorRef"] != want.virtual {
				t.Errorf("vm identity %v", host.Identity)
			}
			if want.hostType == typeHost && host.Identity["primaryMac"] != want.mac {
				t.Errorf("host identity %v", host.Identity)
			}
			if len(host.Components) != len(comps) {
				t.Errorf("host CI components %d want %d", len(host.Components), len(comps))
			}
			wantMetrics := []string{contract.MetricVMCPU, contract.MetricVMMemory, contract.MetricVMDisk}
			if want.hostType == typeHost {
				wantMetrics = []string{contract.MetricHostCPU, contract.MetricHostMemory, contract.MetricHostDisk}
			}
			if len(obs.Samples) != len(wantMetrics) {
				t.Fatalf("samples %+v", obs.Samples)
			}
			for i, s := range obs.Samples {
				if s.Metric != wantMetrics[i] || s.Unit != contract.UnitPercent || s.Ci.Type != want.hostType || !s.Ts.Equal(at) {
					t.Errorf("sample %+v", s)
				}
			}
			if obs.Samples[2].Labels[contract.LabelMount] != want.diskMount {
				t.Errorf("disk sample labels %v", obs.Samples[2].Labels)
			}
			if host.Attributes["packageCount"] != want.packages || host.Attributes["cpuCount"] != 8 || host.Attributes["memoryGb"] != int64(23) {
				t.Errorf("host attributes %v %v %v", host.Attributes["packageCount"], host.Attributes["cpuCount"], host.Attributes["memoryGb"])
			}
			osCis := byType[typeOS]
			if len(osCis) != 1 || osCis[0].Identity["family"] != "linux" || osCis[0].Attributes["distribution"] != want.osID || osCis[0].Identity["version"] != want.osVersionID || osCis[0].Identity["hostRef"] != want.hostname || osCis[0].Name != want.osPretty {
				t.Errorf("operating_system %+v", osCis)
			}
			if len(byType[typeInterface]) != 1 || len(byType[typeIP]) != 1 || byType[typeIP][0].Identity["address"] != want.ip || byType[typeIP][0].Attributes["cidr"] != want.cidr {
				t.Errorf("interface/ip %+v %+v", byType[typeInterface], byType[typeIP])
			}
			var services []string
			for _, ls := range byType[typeListener] {
				services = append(services, ls.Identity["protocol"]+"/"+ls.Identity["port"])
			}
			sort.Strings(services)
			if !equalStrings(services, want.services) {
				t.Errorf("listening services %v want %v", services, want.services)
			}
			var software []string
			for _, sw := range byType[typeSoftware] {
				if sw.Identity["vendor"] != want.osName {
					t.Errorf("software vendor %v", sw.Identity)
				}
				software = append(software, sw.Name)
			}
			sort.Strings(software)
			if !equalStrings(software, want.software) {
				t.Errorf("software %v want %v", software, want.software)
			}
			if len(byType[typeInstall]) != len(want.software) {
				t.Errorf("software_instance count %d", len(byType[typeInstall]))
			}
			rels := map[string]int{}
			for _, r := range obs.Relationships {
				rels[r.Type]++
				if r.Type == relContains && (r.From.Type != want.hostType || (r.To.Type != typeInterface && r.To.Type != typeFwRule && r.To.Type != typeFwObject)) {
					t.Errorf("contains %+v", r)
				}
				if r.Type == relInstalled && r.To.Type != want.hostType {
					t.Errorf("installed_on %+v", r)
				}
				if r.From.Type == typeOS && r.Type != relInstalled {
					t.Errorf("operating system linked by %s, want installed_on", r.Type)
				}
			}
			if len(byType[typeFwRule]) != want.firewallRules || len(byType[typeFwObject]) != want.firewallObjects {
				t.Errorf("firewall CIs: %d rules, %d objects", len(byType[typeFwRule]), len(byType[typeFwObject]))
			}
			wantRels := map[string]int{relRunsOn: len(want.services), relContains: 1 + want.firewallRules + want.firewallObjects, relUsesIP: 1, relInstalled: 1 + len(want.software), relReferences: want.firewallLinks}
			for k, v := range wantRels {
				if rels[k] != v {
					t.Errorf("relationship %s: %d want %d", k, rels[k], v)
				}
			}
		})
	}
	if seen == 0 {
		t.Fatal("no recorded fixtures found")
	}
}

func containsString(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
