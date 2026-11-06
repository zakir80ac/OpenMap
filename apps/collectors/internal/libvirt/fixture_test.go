// T-315 REQ-DISC-007 — recorded vendor fixtures (packages/testing/fixtures/vendor/kvm_libvirt): raw
// stdout of Script() captured over SSH by the real kvm_libvirt collector from libvirtd 9.0.0 + QEMU 7.2
// with one running and one shut-off domain. Split, Assemble and Emit run over each capture.
package libvirt

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/contract"
	"github.com/openmap/openmap/apps/collectors/internal/sshexec"
)

const fixtureRoot = "../../../../packages/testing/fixtures/vendor/kvm_libvirt"

type wantDomain struct {
	uuid, name, state, id string
	vcpus                 int
	memoryMb              int64
	autostart             bool
	macs, nets, disks     []string
}

type libvirtFixture struct {
	hostname, libvirtVersion, qemu string
	cpus                           int
	memoryKiB                      int64
	pools, networks                []string
	poolCapacityBytes              int64
	domains                        []wantDomain
}

var libvirtFixtures = map[string]libvirtFixture{
	"libvirt-libvirt-9.0.0": {
		hostname: "lab-kvm01", libvirtVersion: "9.0.0", qemu: "QEMU 7.2.22", cpus: 8, memoryKiB: 24611036,
		pools: []string{"lab"}, networks: []string{"default"}, poolCapacityBytes: BytesOf("1006.85 GiB"),
		domains: []wantDomain{
			{uuid: "b5bca602-5651-4a02-a97b-ca1ed7238b1c", name: "lab-app01", state: "running", id: "1", vcpus: 1, memoryMb: 256, autostart: true,
				macs: []string{"52:54:00:6c:ea:86"}, nets: []string{"default"}, disks: []string{"app01-root.qcow2"}},
			{uuid: "06937455-9277-42fd-ad82-ac8493f933b8", name: "lab-db01", state: "stopped", id: "-", vcpus: 2, memoryMb: 512, autostart: false,
				macs: []string{"52:54:00:c5:11:20"}, nets: []string{"-"}, disks: []string{"db01-root.qcow2"}},
		},
	},
}

func TestREQDISC007_T315_RecordedVendorFixtures(t *testing.T) {
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
			want, ok := libvirtFixtures[dir]
			if !ok {
				t.Fatalf("fixture %s has no expectation row", dir)
			}
			var manifest struct {
				Family string `json:"family"`
				Req    string `json:"req"`
			}
			mb, err := os.ReadFile(filepath.Join(fixtureRoot, dir, "manifest.json"))
			if err != nil {
				t.Fatal(err)
			}
			if err := json.Unmarshal(mb, &manifest); err != nil || manifest.Family != "kvm_libvirt" || manifest.Req != "REQ-DISC-007" {
				t.Fatalf("manifest: %v %+v", err, manifest)
			}
			raw, err := os.ReadFile(filepath.Join(fixtureRoot, dir, "transcript.txt"))
			if err != nil {
				t.Fatal(err)
			}
			sections, order := sshexec.Split(string(raw))
			n, domains := Assemble(sections, order)
			if n.Hostname != want.hostname || n.FQDN != want.hostname || n.LibvirtVersion != want.libvirtVersion || n.QemuVersion != want.qemu || n.CPUs != want.cpus || n.MemoryKiB != want.memoryKiB || n.CPUModel != "x86_64" {
				t.Errorf("node: %+v", n)
			}
			if len(n.Pools) != len(want.pools) || n.Pools[0].Name != want.pools[0] || n.Pools[0].State != "running" || n.Pools[0].Capacity != "1006.85 GiB" || n.Pools[0].Available != "338.62 GiB" {
				t.Errorf("pools: %+v", n.Pools)
			}
			if !sameStrings(n.Networks, want.networks) {
				t.Errorf("networks: %v", n.Networks)
			}
			if len(domains) != len(want.domains) {
				t.Fatalf("domains: %+v", domains)
			}
			obs := Emit(n, domains, contract.Target{Kind: "host", Value: "127.0.0.1"}, raw, "SHA256:lab", time.Date(2026, 11, 6, 21, 26, 0, 0, time.UTC))
			if len(obs.Evidence) != 1 || string(obs.Evidence[0].Data) != string(raw) {
				t.Error("evidence must carry the raw transcript")
			}
			byType := map[string][]contract.ObservedCi{}
			for _, ci := range obs.Cis {
				byType[ci.Type] = append(byType[ci.Type], ci)
			}
			if len(byType[typeHost]) != 1 || byType[typeHost][0].Identity["fqdn"] != want.hostname || byType[typeHost][0].Attributes["memoryMb"] != want.memoryKiB/kib {
				t.Errorf("host: %+v", byType[typeHost])
			}
			hvs := byType[typeHypervisor]
			if len(hvs) != 1 || hvs[0].Identity["platform"] != platform || hvs[0].Identity["hostRef"] != want.hostname || hvs[0].Attributes["libvirtVersion"] != want.libvirtVersion || hvs[0].Attributes["hypervisor"] != want.qemu || hvs[0].Attributes["domainCount"] != len(want.domains) || hvs[0].Attributes["storagePoolCapacityBytes"] != want.poolCapacityBytes {
				t.Errorf("hypervisor: %+v", hvs)
			}
			vms := byType[typeVM]
			if len(vms) != len(want.domains) || len(byType[typeOS]) != 0 || len(byType[typeIP]) != 0 {
				t.Fatalf("vm/os/ip counts: %d %d %d", len(vms), len(byType[typeOS]), len(byType[typeIP]))
			}
			for i, w := range want.domains {
				vm := vms[i]
				if vm.Name != w.name || vm.Identity["instanceUuid"] != w.uuid || vm.Identity["hypervisorRef"] != want.hostname || len(vm.ExternalIDs) != 1 || vm.ExternalIDs[0].ID != w.uuid {
					t.Errorf("vm %d identity: %+v", i, vm)
				}
				a := vm.Attributes
				if a["powerState"] != w.state || a["libvirtId"] != w.id || a["cpuCount"] != w.vcpus || a["memoryMb"] != w.memoryMb || a["autostart"] != w.autostart || a["persistent"] != true || a["osType"] != "hvm" {
					t.Errorf("vm %d attributes: %v", i, a)
				}
				if !sameStrings(a["macAddresses"].([]string), w.macs) || !sameStrings(a["networks"].([]string), w.nets) || !sameStrings(a["disks"].([]string), w.disks) {
					t.Errorf("vm %d devices: %v %v %v", i, a["macAddresses"], a["networks"], a["disks"])
				}
			}
			rels := map[string]int{}
			for _, r := range obs.Relationships {
				rels[r.Type]++
				if r.Type == relRunsOn && (r.From.Type != typeVM || r.To.Type != typeHypervisor) {
					t.Errorf("runs_on %+v", r)
				}
				if r.Type == relHostedOn && (r.From.Type != typeHypervisor || r.To.Type != typeHost) {
					t.Errorf("hosted_on %+v", r)
				}
			}
			if rels[relHostedOn] != 1 || rels[relRunsOn] != len(want.domains) || len(obs.Relationships) != 1+len(want.domains) {
				t.Errorf("relationships: %v", rels)
			}
		})
	}
	if seen == 0 {
		t.Fatal("no recorded fixtures found")
	}
}

func sameStrings(a, b []string) bool {
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
