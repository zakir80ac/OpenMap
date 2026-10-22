// T-020 REQ-DISC-003 — parsers over transcripts in the shape Ubuntu 24.04 and RHEL 9 produce.
package sshlinux

import (
	"strings"
	"testing"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

const transcript = `
@@OPENMAP:hostname@@
db-ryd-pg-core-01
@@OPENMAP:fqdn@@
db-ryd-pg-core-01.bank.local
@@OPENMAP:machine_id@@
8f0b2c1d4e5f4a6b9c8d7e6f5a4b3c2d
@@OPENMAP:os_release@@
PRETTY_NAME="Ubuntu 24.04.1 LTS"
NAME="Ubuntu"
VERSION_ID="24.04"
VERSION="24.04.1 LTS (Noble Numbat)"
ID=ubuntu
@@OPENMAP:kernel@@
6.8.0-45-generic
@@OPENMAP:arch@@
x86_64
@@OPENMAP:uptime@@
864000.12 3400000.00
@@OPENMAP:cpuinfo@@
processor	: 0
model name	: Intel(R) Xeon(R) Gold 6448Y
processor	: 1
model name	: Intel(R) Xeon(R) Gold 6448Y
@@OPENMAP:meminfo@@
MemTotal:       527482880 kB
@@OPENMAP:dmi@@
product_serial=7KQ2M93
product_uuid=4C4C4544-004B-5110-8032-B4C04F4D3933
sys_vendor=Dell Inc.
product_name=PowerEdge R760
bios_version=2.4.1
virt=none
@@OPENMAP:ip_addr@@
1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN group default qlen 1000
    link/loopback 00:00:00:00:00:00 brd 00:00:00:00:00:00
    inet 127.0.0.1/8 scope host lo
2: eno1: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 9000 qdisc mq state UP group default qlen 1000
    link/ether b4:96:91:aa:bb:01 brd ff:ff:ff:ff:ff:ff
    inet 10.20.4.18/24 brd 10.20.4.255 scope global eno1
    inet6 fe80::b696:91ff:feaa:bb01/64 scope link
3: eno2: <BROADCAST,MULTICAST> mtu 1500 qdisc noop state DOWN group default qlen 1000
    link/ether b4:96:91:aa:bb:02 brd ff:ff:ff:ff:ff:ff
@@OPENMAP:ss@@
tcp   LISTEN 0      244          0.0.0.0:5432      0.0.0.0:*    users:(("postgres",pid=1203,fd=6))
tcp   LISTEN 0      128          0.0.0.0:22        0.0.0.0:*    users:(("sshd",pid=801,fd=3))
tcp   LISTEN 0      128        127.0.0.1:8008      0.0.0.0:*    users:(("patroni",pid=1190,fd=9))
udp   UNCONN 0      0            0.0.0.0:161       0.0.0.0:*    users:(("snmpd",pid=900,fd=7))
@@OPENMAP:packages@@
openssl	3.0.13-0ubuntu3.4	amd64
postgresql-16	16.4-1.pgdg24.04+1	amd64
vim	2:9.1.0016-1ubuntu7	amd64
@@OPENMAP:lsblk@@
nvme0n1 1.7T disk Dell Ent NVMe
sda     7T disk PERC H755
@@OPENMAP:df@@
Filesystem     1024-blocks      Used Available Capacity Mounted on
/dev/nvme0n1p2   1800000000 400000000 1400000000  23% /
/dev/sda1        7000000000 900000000 6100000000  13% /var/lib/postgresql
`

func TestAssembleFacts(t *testing.T) {
	f := Assemble(Split(transcript))
	if f.FQDN != "db-ryd-pg-core-01.bank.local" || f.Serial != "7KQ2M93" || f.Manufacturer != "Dell Inc." || f.Model != "PowerEdge R760" || f.Virtual != "" {
		t.Fatalf("host facts wrong: %+v", f)
	}
	if f.OS.ID != "ubuntu" || f.OS.VersionID != "24.04" || f.CPUCount != 2 || f.MemoryKB != 527482880 {
		t.Fatalf("os/cpu/mem wrong: %+v %d %d", f.OS, f.CPUCount, f.MemoryKB)
	}
	if len(f.Interfaces) != 2 || f.Interfaces[0].Name != "eno1" || f.Interfaces[0].MTU != 9000 || f.Interfaces[0].State != "up" || f.Interfaces[1].State != "down" {
		t.Fatalf("interfaces wrong: %+v", f.Interfaces)
	}
	if len(f.Listeners) != 4 || f.Listeners[0].Port != 5432 || f.Listeners[0].Process != "postgres" || f.Listeners[3].Proto != "udp" {
		t.Fatalf("listeners wrong: %+v", f.Listeners)
	}
	if len(f.Packages) != 3 || len(f.Disks) != 2 || len(f.Mounts) != 2 || f.Mounts[1].Path != "/var/lib/postgresql" {
		t.Fatalf("packages/disks/mounts wrong: %d %d %+v", len(f.Packages), len(f.Disks), f.Mounts)
	}
}

func TestEmitHost(t *testing.T) {
	f := Assemble(Split(transcript))
	obs := Emit(f, contract.Target{Kind: "host", Value: "10.20.4.18"}, []byte(transcript), time.Now())
	host := obs.Cis[0]
	if host.Type != typeHost || host.Identity["serialNumber"] != "7KQ2M93" || host.Identity["primaryMac"] != "b4:96:91:aa:bb:01" || host.Identity["fqdn"] == "" {
		t.Fatalf("host identity wrong: %+v", host.Identity)
	}
	counts := map[string]int{}
	for _, ci := range obs.Cis {
		counts[ci.Type]++
	}
	if counts[typeOS] != 1 || counts[typeInterface] != 2 || counts[typeIP] != 1 || counts[typeListener] != 3 || counts[typeSoftware] != 2 || counts[typeInstall] != 2 {
		t.Fatalf("ci counts wrong: %+v", counts)
	}
	rels := map[string]int{}
	for _, r := range obs.Relationships {
		rels[r.Type]++
	}
	if rels[relRunsOn] != 4 || rels[relUsesIP] != 1 || rels[relInstalled] != 2 || rels[relContains] != 2 {
		t.Fatalf("relationship counts wrong: %+v", rels)
	}
}

func TestVirtualMachineIdentity(t *testing.T) {
	parts := Split(strings.Replace(transcript, "virt=none", "virt=vmware", 1))
	f := Assemble(parts)
	obs := Emit(f, contract.Target{Kind: "host", Value: "x"}, nil, time.Now())
	if obs.Cis[0].Type != typeVM || obs.Cis[0].Identity["instanceUuid"] == "" || obs.Cis[0].Identity["hypervisorRef"] != "vmware" {
		t.Fatalf("vm identity wrong: %+v", obs.Cis[0])
	}
}

func TestScriptRoundTrip(t *testing.T) {
	s := Script()
	for _, c := range Commands {
		if !strings.Contains(s, "@@OPENMAP:"+c.Key+"@@") {
			t.Fatalf("script missing marker for %s", c.Key)
		}
	}
}
