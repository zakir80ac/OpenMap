// T-300 REQ-DISC-003 — recorded vendor fixtures: raw stdout of Script() captured over SSH by the real
// ssh_agentless collector from Ubuntu, Debian, AlmaLinux, Alpine and Amazon Linux (container lab,
// packages/testing/fixtures/vendor/ssh_agentless). Split, Assemble and Emit run over each capture.
package sshlinux

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"testing"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

const fixtureRoot = "../../../../packages/testing/fixtures/vendor/ssh_agentless"

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
}

var fixtureExpectations = map[string]fixtureExpect{
	"canonical-ubuntu-24.04.5": {
		hostname: "lab-ubuntu2404", osID: "ubuntu", osVersionID: "24.04", osPretty: "Ubuntu 24.04.5 LTS", osName: "Ubuntu",
		hostType: typeVM, virtual: "wsl", machineID: "b119510d7faf405ca63a2e8d71df76c2", mac: "6e:20:d0:45:4e:d7", ip: "192.168.112.2", cidr: "192.168.112.2/20",
		packages: 197, disks: 6, mounts: 1, listeners: 6, services: []string{"tcp/22", "tcp/80"},
		software: []string{"libc6 2.39-0ubuntu8.9", "nginx 1.24.0-2ubuntu7.19", "openssh-server 1:9.6p1-3ubuntu13.20", "openssl 3.0.13-0ubuntu3.16", "python3 3.12.3-0ubuntu2.1", "systemd 255.4-1ubuntu8.18"},
	},
	"debian-debian-12": {
		hostname: "lab-debian12", osID: "debian", osVersionID: "12", osPretty: "Debian GNU/Linux 12 (bookworm)", osName: "Debian GNU/Linux",
		hostType: typeVM, virtual: "wsl", machineID: "ca19c3b9a9644121b6eedf1f44334056", mac: "12:c4:e8:b6:f7:6a", ip: "192.168.112.3", cidr: "192.168.112.3/20",
		packages: 157, disks: 6, mounts: 1, listeners: 6, services: []string{"tcp/22", "tcp/80"},
		software: []string{"libc6 2.36-9+deb12u14", "nginx 1.22.1-9+deb12u10", "openssh-server 1:9.2p1-2+deb12u10", "openssl 3.0.22-1~deb12u2", "systemd 252.39-1~deb12u2"},
	},
	"almalinux-almalinux-9.8": {
		hostname: "lab-alma9", osID: "almalinux", osVersionID: "9.8", osPretty: "AlmaLinux 9.8 (Olive Jaguar)", osName: "AlmaLinux",
		hostType: typeVM, virtual: "wsl", machineID: "", mac: "5a:d7:56:2b:57:a1", ip: "192.168.112.4", cidr: "192.168.112.4/20",
		packages: 171, disks: 6, mounts: 1, listeners: 6, services: []string{"tcp/22", "tcp/80"},
		software: []string{"glibc 2.34-283.el9_8", "nginx 1.20.1-28.el9_8.6.alma.1", "openssh-server 9.9p1-13.el9_8.alma.1", "openssl 3.5.8-2.el9_8", "python3 3.9.25-7.el9_8.6", "systemd 252-67.el9_8.6.alma.1"},
	},
	"alpine-alpine-3.20.10": {
		hostname: "lab-alpine320", osID: "alpine", osVersionID: "3.20.10", osPretty: "Alpine Linux v3.20", osName: "Alpine Linux",
		hostType: typeHost, virtual: "unknown", machineID: "", mac: "16:5a:fa:7f:7d:43", ip: "192.168.112.5", cidr: "192.168.112.5/20",
		packages: 27, disks: 0, mounts: 14, listeners: 6, services: []string{"tcp/22", "tcp/80"},
		software: []string{"nginx 1.26.3-r0", "openssh-server 9.7_p1-r6", "openssl 3.3.7-r0"},
	},
	"aws-amazonlinux-2023.12.20261102": {
		hostname: "lab-al2023", osID: "amzn", osVersionID: "2023", osPretty: "Amazon Linux 2023.12.20261102", osName: "Amazon Linux",
		hostType: typeVM, virtual: "wsl", machineID: "d1e65b4908844abeb8253b5a4e7f9fc8", mac: "9e:6e:a1:bc:fa:fe", ip: "192.168.112.6", cidr: "192.168.112.6/20",
		packages: 165, disks: 6, mounts: 1, listeners: 6, services: []string{"tcp/22", "tcp/80"},
		software: []string{"glibc 2.34-231.amzn2023.0.5", "nginx 1.30.6-1.amzn2023.0.1", "openssh-server 9.9p1-16.amzn2023.0.1", "openssl 3.5.8-1.amzn2023.0.3", "python3 3.9.25-1.amzn2023.0.11", "systemd 252.23-15.amzn2023"},
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
				if _, ok := parts[c.Key]; !ok {
					t.Errorf("section %s missing from the transcript", c.Key)
				}
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
			if host.Attributes["packageCount"] != want.packages || host.Attributes["cpuCount"] != 8 || host.Attributes["memoryGb"] != int64(23) {
				t.Errorf("host attributes %v %v %v", host.Attributes["packageCount"], host.Attributes["cpuCount"], host.Attributes["memoryGb"])
			}
			osCis := byType[typeOS]
			if len(osCis) != 1 || osCis[0].Identity["family"] != want.osID || osCis[0].Identity["version"] != want.osVersionID || osCis[0].Identity["hostRef"] != want.hostname || osCis[0].Name != want.osPretty {
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
				if r.Type == relContains && (r.From.Type != want.hostType || r.To.Type != typeInterface) {
					t.Errorf("contains %+v", r)
				}
				if r.Type == relInstalled && r.To.Type != want.hostType {
					t.Errorf("installed_on %+v", r)
				}
			}
			wantRels := map[string]int{relRunsOn: 1 + len(want.services), relContains: 1, relUsesIP: 1, relInstalled: len(want.software)}
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
