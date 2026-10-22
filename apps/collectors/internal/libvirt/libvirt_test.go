// T-037 REQ-DISC-007 — splits a captured virsh script transcript (libvirt 10.0 formats) and checks
// the hypervisor, host, domain, guest OS and address observations. Recordings from real hosts live
// under packages/testing/fixtures/vendor/kvm_libvirt.
package libvirt

import (
	"testing"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/contract"
	"github.com/openmap/openmap/apps/collectors/internal/sshexec"
)

const transcript = `
@@OPENMAP:hostname@@
kvm-ryd-01

@@OPENMAP:fqdn@@
kvm-ryd-01.corp.example

@@OPENMAP:version@@
Compiled against library: libvirt 10.0.0
Using library: libvirt 10.0.0
Using API: QEMU 10.0.0
Running hypervisor: QEMU 8.2.2

@@OPENMAP:nodeinfo@@
CPU model:           x86_64
CPU(s):              64
CPU frequency:       2100 MHz
CPU socket(s):       1
Core(s) per socket:  16
Thread(s) per core:  2
NUMA cell(s):        2
Memory size:         527908068 KiB

@@OPENMAP:dmi@@
product_uuid=4C4C4544-0059-3810-8057-C4C04F305A33
product_serial=9Y8W5Z3
sys_vendor=Dell Inc.
product_name=PowerEdge R7625

@@OPENMAP:pools@@
 Name      State    Autostart   Persistent   Capacity     Allocation   Available
----------------------------------------------------------------------------------
 default   running  yes         yes          3.49 TiB     1.20 TiB     2.29 TiB
 iso       running  yes         yes          500.00 GiB   120.00 GiB   380.00 GiB

@@OPENMAP:nets@@
 Name      State    Autostart   Persistent
--------------------------------------------
 br-prod   active   yes         yes
 default   active   yes         yes

@@OPENMAP:list@@
9a1b2c3d-0000-4000-8000-000000000001
9a1b2c3d-0000-4000-8000-000000000002

@@OPENMAP:dom:9a1b2c3d-0000-4000-8000-000000000001@@
Id:             3
Name:           erp-app-01
UUID:           9a1b2c3d-0000-4000-8000-000000000001
OS Type:        hvm
State:          running
CPU(s):         8
CPU time:       91234.5s
Max memory:     33554432 KiB
Used memory:    33554432 KiB
Persistent:     yes
Autostart:      enable
Managed save:   no
Security model: selinux
Security DOI:   0

@@OPENMAP:ifs:9a1b2c3d-0000-4000-8000-000000000001@@
 Interface   Type     Source    Model    MAC
-----------------------------------------------------------
 vnet3       bridge   br-prod   virtio   52:54:00:AB:CD:01

@@OPENMAP:blk:9a1b2c3d-0000-4000-8000-000000000001@@
 Type   Device   Target   Source
------------------------------------------------------------
 file   disk     vda      /var/lib/libvirt/images/erp-app-01.qcow2
 file   cdrom    sda      -

@@OPENMAP:addr:9a1b2c3d-0000-4000-8000-000000000001@@
 Name       MAC address          Protocol     Address
-------------------------------------------------------------------------------
 lo         00:00:00:00:00:00    ipv4         127.0.0.1/8
 -          -                    ipv6         ::1/128
 eth0       52:54:00:ab:cd:01    ipv4         10.150.2.21/24
 -          -                    ipv6         fe80::5054:ff:feab:cd01/64

@@OPENMAP:os:9a1b2c3d-0000-4000-8000-000000000001@@
os.id               : rhel
os.name             : Red Hat Enterprise Linux
os.pretty-name      : Red Hat Enterprise Linux 9.4 (Plow)
os.version          : 9.4 (Plow)
os.version-id       : 9.4
os.kernel-release   : 5.14.0-427.13.1.el9_4.x86_64
os.machine          : x86_64

@@OPENMAP:ghost:9a1b2c3d-0000-4000-8000-000000000001@@
hostname            : erp-app-01.corp.example

@@OPENMAP:dom:9a1b2c3d-0000-4000-8000-000000000002@@
Id:             -
Name:           win-print-01
UUID:           9a1b2c3d-0000-4000-8000-000000000002
OS Type:        hvm
State:          shut off
CPU(s):         4
Max memory:     8388608 KiB
Used memory:    0 KiB
Persistent:     yes
Autostart:      disable

@@OPENMAP:ifs:9a1b2c3d-0000-4000-8000-000000000002@@
 Interface   Type     Source    Model    MAC
-----------------------------------------------------------
 -           bridge   br-prod   e1000e   52:54:00:AB:CD:02

@@OPENMAP:blk:9a1b2c3d-0000-4000-8000-000000000002@@
 Type   Device   Target   Source
------------------------------------------------------------
 file   disk     sda      /var/lib/libvirt/images/win-print-01.qcow2

@@OPENMAP:addr:9a1b2c3d-0000-4000-8000-000000000002@@

@@OPENMAP:os:9a1b2c3d-0000-4000-8000-000000000002@@

@@OPENMAP:ghost:9a1b2c3d-0000-4000-8000-000000000002@@
`

func count(cis []contract.ObservedCi, typ string) int {
	n := 0
	for _, c := range cis {
		if c.Type == typ {
			n++
		}
	}
	return n
}

func TestAssembleAndEmit(t *testing.T) {
	sections, order := sshexec.Split(transcript)
	node, domains := Assemble(sections, order)
	if node.FQDN != "kvm-ryd-01.corp.example" || node.CPUs != 64 || node.LibvirtVersion != "10.0.0" || node.QemuVersion != "QEMU 8.2.2" || node.ProductSerial != "9Y8W5Z3" || len(node.Pools) != 2 || len(node.Networks) != 2 {
		t.Fatalf("node wrong: %+v", node)
	}
	if len(domains) != 2 || domains[0].Name != "erp-app-01" || domains[0].VCPUs != 8 || domains[0].MaxMemKiB != 33554432 || !domains[0].Autostart || len(domains[0].Interfaces) != 1 || len(domains[0].Disks) != 2 || len(domains[0].Addresses) != 4 {
		t.Fatalf("domains wrong: %+v", domains)
	}
	obs := Emit(node, domains, contract.Target{Kind: "host", Value: "10.150.0.11"}, []byte(transcript), "SHA256:abc", time.Now())
	if count(obs.Cis, typeHost) != 1 || count(obs.Cis, typeHypervisor) != 1 || count(obs.Cis, typeVM) != 2 || count(obs.Cis, typeOS) != 1 || count(obs.Cis, typeIP) != 1 {
		t.Fatalf("unexpected CI mix: %+v", obs.Cis)
	}
	for _, ci := range obs.Cis {
		switch {
		case ci.Type == typeVM && ci.Name == "erp-app-01":
			if ci.Identity["instanceUuid"] != "9a1b2c3d-0000-4000-8000-000000000001" || ci.Identity["hypervisorRef"] != "kvm-ryd-01.corp.example" || ci.Identity["fqdn"] != "erp-app-01.corp.example" || ci.Attributes["memoryMb"] != int64(32768) || ci.Attributes["diskCount"] != 1 {
				t.Fatalf("vm wrong: %+v", ci)
			}
		case ci.Type == typeVM && ci.Name == "win-print-01":
			if ci.Attributes["powerState"] != "stopped" || ci.Identity["fqdn"] != "" {
				t.Fatalf("stopped vm wrong: %+v", ci)
			}
		case ci.Type == typeOS:
			if ci.Identity["family"] != "linux" || ci.Identity["version"] != "9.4" {
				t.Fatalf("os wrong: %+v", ci)
			}
		case ci.Type == typeIP:
			if ci.Identity["address"] != "10.150.2.21" || ci.Attributes["mac"] != "52:54:00:ab:cd:01" {
				t.Fatalf("ip wrong: %+v", ci)
			}
		case ci.Type == typeHost:
			if ci.Identity["systemUuid"] != "4c4c4544-0059-3810-8057-c4c04f305a33" || ci.Attributes["sshHostKeySha256"] != "SHA256:abc" {
				t.Fatalf("host wrong: %+v", ci)
			}
		case ci.Type == typeHypervisor:
			if ci.Attributes["storagePoolCapacityBytes"] != BytesOf("3.49 TiB")+BytesOf("500.00 GiB") {
				t.Fatalf("pool capacity wrong: %+v", ci.Attributes["storagePoolCapacityBytes"])
			}
		}
	}
	rels := map[string]int{}
	for _, r := range obs.Relationships {
		rels[r.Type]++
	}
	if rels[relHostedOn] != 1 || rels[relRunsOn] != 2 || rels[relInstalledOn] != 1 || rels[relUsesIP] != 1 {
		t.Fatalf("relationship mix wrong: %+v", rels)
	}
}

func TestScriptMarkersRoundTrip(t *testing.T) {
	s := Script()
	for _, key := range []string{keyHostname, keyVersion, keyList} {
		if !contains(s, sshexec.Marker(key)) {
			t.Fatalf("script lacks marker for %s", key)
		}
	}
}

func contains(s, sub string) bool {
	return len(s) >= len(sub) && (func() bool {
		for i := 0; i+len(sub) <= len(s); i++ {
			if s[i:i+len(sub)] == sub {
				return true
			}
		}
		return false
	})()
}
