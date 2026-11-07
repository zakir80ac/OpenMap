// REQ-QA-005 REQ-DISC-007 — simulated KVM/libvirt hypervisors over SSH for the kvm_libvirt collector. The synthetic
// estate has no plain KVM hosts (its AHV hosts are Nutanix-managed and simulated through Prism), so this simulator
// serves a small deterministic set defined below: two libvirt hosts (RHEL 9 and Ubuntu 24.04 builds of libvirt and
// QEMU) with running guests that have the QEMU guest agent, a guest without the agent whose address comes from the
// dnsmasq lease table, and a shut-off guest. Each host is its own SSH daemon with a per-server host key; it answers
// the collector's script by rendering every section (virsh version/nodeinfo/pool-list/net-list/list and, for each
// domain the `for u in $(V list --all --uuid)` loop visits, dominfo, domiflist, domblklist, domifaddr and guestinfo)
// in the formats of the recorded libvirt 9.0 transcript under packages/testing/fixtures/vendor/kvm_libvirt.
// Expectations come from the same set. Proxmox VE is not simulated: it runs QEMU through qemu-server without
// libvirt, so virsh is absent there and the collector answers unsupported_device.
package kvmlibvirt

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"

	"github.com/openmap/openmap/tools/simulator/internal/estate"
	"github.com/openmap/openmap/tools/simulator/internal/protocols/sshd"
	"github.com/openmap/openmap/tools/simulator/internal/sim"
)

const (
	kibPerMiB   = 1024
	stateRun    = "running"
	stateOff    = "shut off"
	netDefault  = "default"
	netBridge   = "br0"
	sourceAgent = "agent"
	sourceLease = "lease"
)

type Vendor struct{}

func (Vendor) ID() string             { return "kvm-libvirt" }
func (Vendor) Collector() string      { return "kvm_libvirt" }
func (Vendor) Requirements() []string { return []string{"REQ-DISC-007"} }

type guestOS struct {
	id, name, pretty, version, versionID, kernel string
}

var (
	rhel94   = guestOS{"rhel", "Red Hat Enterprise Linux", "Red Hat Enterprise Linux 9.4 (Plow)", "9.4 (Plow)", "9.4", "5.14.0-427.37.1.el9_4.x86_64"}
	ubuntu24 = guestOS{"ubuntu", "Ubuntu", "Ubuntu 24.04 LTS", "24.04 LTS (Noble Numbat)", "24.04", "6.8.0-45-generic"}
	win2022  = guestOS{"mswindows", "Microsoft Windows Server 2022 Standard", "Microsoft Windows Server 2022 Standard", "Microsoft Windows Server 2022 Standard", "2022", "10.0.20348"}
)

type domain struct {
	name    string
	state   string
	vcpus   int
	memMiB  int
	network string
	source  string // agent, lease or "" (no address source answers)
	address string // CIDR
	os      *guestOS
	fqdn    string
	cdrom   bool
}

type hypervisor struct {
	hostname, fqdn, vendor, product, serial string
	libvirt, qemu                           string
	cpus                                    int
	memGiB                                  int
	pool                                    string
	domains                                 []domain
	server                                  *sshd.Server
}

// hypervisors is the seeded set (the estate has no plain libvirt hosts).
var hypervisors = []hypervisor{
	{hostname: "kvm-ryd-01", fqdn: "kvm-ryd-01.bank.local", vendor: "Dell Inc.", product: "PowerEdge R760", serial: "KVMRYD1", libvirt: "10.0.0", qemu: "QEMU 8.2.0", cpus: 64, memGiB: 512, pool: "images",
		domains: []domain{
			{name: "app-kvm-ryd-01", state: stateRun, vcpus: 4, memMiB: 8192, network: netBridge, source: sourceAgent, address: "10.30.0.21/24", os: &rhel94, fqdn: "app-kvm-ryd-01.bank.local"},
			{name: "app-kvm-ryd-02", state: stateRun, vcpus: 4, memMiB: 8192, network: netBridge, source: sourceAgent, address: "10.30.0.22/24", os: &ubuntu24, fqdn: "app-kvm-ryd-02.bank.local"},
			{name: "ci-runner-ryd-01", state: stateRun, vcpus: 8, memMiB: 16384, network: netDefault, source: sourceLease, address: "192.168.122.34/24"},
			{name: "tmpl-rhel9", state: stateOff, vcpus: 2, memMiB: 4096, network: netDefault, cdrom: true},
		}},
	{hostname: "kvm-jed-01", fqdn: "kvm-jed-01.bank.local", vendor: "HPE", product: "ProLiant DL380 Gen11", serial: "CZKVMJED1", libvirt: "10.0.0", qemu: "QEMU 8.2.2", cpus: 48, memGiB: 384, pool: "default",
		domains: []domain{
			{name: "db-kvm-jed-01", state: stateRun, vcpus: 8, memMiB: 32768, network: netBridge, source: sourceAgent, address: "10.31.0.11/24", os: &rhel94, fqdn: "db-kvm-jed-01.bank.local"},
			{name: "ad-kvm-jed-01", state: stateRun, vcpus: 2, memMiB: 4096, network: netBridge, source: sourceAgent, address: "10.31.0.12/24", os: &win2022, fqdn: "ad-kvm-jed-01.bank.local"},
			{name: "lab-kvm-jed-01", state: stateOff, vcpus: 1, memMiB: 2048, network: netDefault},
		}},
}

func digest(parts ...string) string {
	sum := sha256.Sum256([]byte(strings.Join(parts, "\x00")))
	return hex.EncodeToString(sum[:])
}

func uuidOf(s string) string {
	h := digest("libvirt-uuid", s)
	return h[0:8] + "-" + h[8:12] + "-4" + h[13:16] + "-a" + h[17:20] + "-" + h[20:32]
}

func macOf(s string) string {
	h := digest("libvirt-mac", s)
	return "52:54:00:" + h[0:2] + ":" + h[2:4] + ":" + h[4:6]
}

func (h *hypervisor) productUUID() string { return uuidOf("host-" + h.fqdn) }

func (h *hypervisor) static(key string) string {
	switch key {
	case "hostname":
		return h.hostname
	case "fqdn":
		return h.fqdn
	case "version":
		return "Compiled against library: libvirt " + h.libvirt + "\nUsing library: libvirt " + h.libvirt + "\nUsing API: QEMU " + h.libvirt +
			"\nRunning hypervisor: " + h.qemu + "\nRunning against daemon: " + h.libvirt + "\n"
	case "nodeinfo":
		return fmt.Sprintf("CPU model:           x86_64\nCPU(s):              %d\nCPU frequency:       2400 MHz\nCPU socket(s):       1\nCore(s) per socket:  %d\nThread(s) per core:  2\nNUMA cell(s):        2\nMemory size:         %d KiB\n",
			h.cpus, h.cpus/2, h.memGiB*kibPerMiB*kibPerMiB)
	case "dmi":
		return "product_uuid=" + h.productUUID() + "\nproduct_serial=" + h.serial + "\nsys_vendor=" + h.vendor + "\nproduct_name=" + h.product
	case "pools":
		return " Name      State     Autostart   Persistent   Capacity     Allocation   Available\n" +
			"-----------------------------------------------------------------------------------\n" +
			fmt.Sprintf(" %-9s running   yes         yes          3.49 TiB     1.12 TiB     2.37 TiB\n", h.pool)
	case "nets":
		return " Name      State    Autostart   Persistent\n--------------------------------------------\n default   active   yes         yes\n"
	case "list":
		var b strings.Builder
		for _, d := range h.domains {
			b.WriteString(uuidOf(h.fqdn+"/"+d.name) + "\n")
		}
		return b.String()
	default:
		return ""
	}
}

func (h *hypervisor) perDomain(kind string, id int, d domain) string {
	uuid := uuidOf(h.fqdn + "/" + d.name)
	mac := macOf(h.fqdn + "/" + d.name)
	running := d.state == stateRun
	switch kind {
	case "dom":
		idText, cpuTime, used := "-", "", d.memMiB*kibPerMiB
		if running {
			idText, cpuTime = fmt.Sprint(id), "CPU time:       8412.3s\n"
		}
		autostart := "disable"
		if running {
			autostart = "enable"
		}
		return fmt.Sprintf("Id:             %s\nName:           %s\nUUID:           %s\nOS Type:        hvm\nState:          %s\nCPU(s):         %d\n%sMax memory:     %d KiB\nUsed memory:    %d KiB\nPersistent:     yes\nAutostart:      %s\nManaged save:   no\nSecurity model: selinux\nSecurity DOI:   0\n",
			idText, d.name, uuid, d.state, d.vcpus, cpuTime, d.memMiB*kibPerMiB, used, autostart)
	case "ifs":
		ifType, vnet := "bridge", "vnet"+fmt.Sprint(id)
		if d.network == netDefault {
			ifType = "network"
		}
		if !running {
			vnet = "-"
		}
		return " Interface   Type      Source    Model    MAC\n-------------------------------------------------------------\n" +
			fmt.Sprintf(" %-11s %-9s %-9s virtio   %s\n", vnet, ifType, d.network, mac)
	case "blk":
		out := " Type   Device   Target   Source\n------------------------------------------------\n" +
			fmt.Sprintf(" file   disk     vda      /var/lib/libvirt/images/%s.qcow2\n", d.name)
		if d.cdrom {
			out += " file   cdrom    sda      -\n"
		}
		return out
	case "addr":
		head := " Name       MAC address          Protocol     Address\n-------------------------------------------------------------------------------\n"
		switch {
		case !running || d.source == "":
			return ""
		case d.source == sourceAgent:
			return head + " lo         00:00:00:00:00:00    ipv4         127.0.0.1/8\n -          -                    ipv6         ::1/128\n" +
				fmt.Sprintf(" eth0       %s    ipv4         %s\n -          -                    ipv6         fe80::5054:ff:fe%s:%s%s/64\n", mac, d.address, mac[9:11], mac[12:14], mac[15:17])
		default:
			return head + fmt.Sprintf(" vnet%d      %s    ipv4         %s\n", id, mac, d.address)
		}
	case "os":
		if !running || d.source != sourceAgent || d.os == nil {
			return ""
		}
		o := d.os
		return fmt.Sprintf("os.id               : %s\nos.name             : %s\nos.pretty-name      : %s\nos.version          : %s\nos.version-id       : %s\nos.kernel-release   : %s\nos.machine          : x86_64\n",
			o.id, o.name, o.pretty, o.version, o.versionID, o.kernel)
	case "ghost":
		if !running || d.source != sourceAgent || d.fqdn == "" {
			return ""
		}
		return "hostname            : " + d.fqdn + "\n"
	default:
		return ""
	}
}

// render emulates the shell running the script: static sections in order, then the per-domain loop.
func (h *hypervisor) render(script string) string {
	var b strings.Builder
	var loop []sshd.Section
	for _, s := range sshd.Sections(script) {
		if s.Templated() {
			loop = append(loop, s)
			continue
		}
		b.WriteString(sshd.Frame(s.Key, h.static(s.Key)))
	}
	running := 0
	for _, d := range h.domains {
		uuid := uuidOf(h.fqdn + "/" + d.name)
		if d.state == stateRun {
			running++
		}
		for _, s := range loop {
			kind, _, _ := strings.Cut(s.Key, ":")
			b.WriteString(sshd.Frame(s.Expand(uuid), h.perDomain(kind, running, d)))
		}
	}
	return b.String()
}

func (Vendor) Start(_ context.Context, _ *estate.Estate, env *sim.Env) (*sim.Endpoint, error) {
	hvs := make([]*hypervisor, 0, len(hypervisors))
	ep := &sim.Endpoint{Host: sim.AdvertiseHost(), State: map[string]any{}}
	for i := range hypervisors {
		h := hypervisors[i]
		srv, err := sshd.Serve(env, sshd.Shell(h.render), sshd.Config{})
		if err != nil {
			_ = ep.Close()
			return nil, err
		}
		h.server = srv
		ep.OnClose(srv.Close)
		hvs = append(hvs, &h)
	}
	ep.State["hypervisors"] = hvs
	return ep, nil
}

func (Vendor) Runs(_ *estate.Estate, ep *sim.Endpoint, env *sim.Env) []sim.Run {
	hvs, _ := ep.State["hypervisors"].([]*hypervisor)
	var runs []sim.Run
	for _, h := range hvs {
		cred := sshd.PasswordCredential(env)
		run := sim.Run{Name: h.hostname, Targets: []sim.Target{h.server.Target(h.hostname)}, Options: h.server.Options(), CredentialType: cred.Type, Credential: cred}
		x := &run.Expect
		x.CIs = append(x.CIs, sim.ExpectCI{Type: "host", Name: h.fqdn, Identity: map[string]string{"fqdn": h.fqdn, "systemUuid": h.productUUID(), "serialNumber": h.serial}})
		x.CI("hypervisor", h.fqdn)
		x.Rel("hosted_on", "hypervisor", h.fqdn, "host", h.fqdn)
		for _, d := range h.domains {
			x.CIs = append(x.CIs, sim.ExpectCI{Type: "vm", Name: d.name, Identity: map[string]string{"instanceUuid": uuidOf(h.fqdn + "/" + d.name)}})
			x.Rel("runs_on", "vm", d.name, "hypervisor", h.fqdn)
			running := d.state == stateRun
			if running && d.source == sourceAgent && d.os != nil {
				x.CI("operating_system", d.os.pretty)
				x.Rel("installed_on", "operating_system", d.os.pretty, "vm", d.name)
			}
			if running && d.source != "" {
				addr, _, _ := strings.Cut(d.address, "/")
				x.CI("ip_address", addr)
				x.Rel("uses_ip", "vm", d.name, "ip_address", addr)
			}
		}
		runs = append(runs, run)
	}
	return runs
}
