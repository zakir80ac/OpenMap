// REQ-DISC-007 — KVM / libvirt collector over SSH: one session runs read-only virsh commands on the
// hypervisor (falling back to passwordless sudo) and emits the hypervisor, its physical host, every
// domain with NICs, disks, guest-agent addresses and OS, plus runs_on / hosted_on / uses_ip /
// installed_on relationships. Covers plain libvirt, oVirt/OLVM and Proxmox hosts alike.
package libvirt

import (
	"context"
	"strings"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/collector"
	"github.com/openmap/openmap/apps/collectors/internal/contract"
	"github.com/openmap/openmap/apps/collectors/internal/sshexec"
)

const (
	collectorID  = "kvm_libvirt"
	version      = "0.1.0"
	platform     = "kvm"
	evidenceKind = "cli_output"
	kib          = 1024

	typeHypervisor = "hypervisor"
	typeHost       = "host"
	typeVM         = "vm"
	typeOS         = "operating_system"
	typeIP         = "ip_address"
	relHostedOn    = "hosted_on"
	relRunsOn      = "runs_on"
	relInstalledOn = "installed_on"
	relUsesIP      = "uses_ip"

	keyHostname = "hostname"
	keyFQDN     = "fqdn"
	keyVersion  = "version"
	keyNodeinfo = "nodeinfo"
	keyDmi      = "dmi"
	keyPools    = "pools"
	keyNets     = "nets"
	keyList     = "list"
	prefixDom   = "dom:"
	prefixIfs   = "ifs:"
	prefixBlk   = "blk:"
	prefixAddr  = "addr:"
	prefixOS    = "os:"
	prefixHost  = "ghost:"
)

type Collector struct{}

func (Collector) Manifest() contract.Manifest {
	return contract.Manifest{
		ID: collectorID, Family: "kvm_libvirt", Version: version, Language: "go",
		Protocols: []string{"ssh"}, CredentialTypes: []string{"password", "ssh_key"},
		TargetKinds: []string{"host"}, Emits: []string{typeHypervisor, typeHost, typeVM, typeOS, typeIP},
		ContractVersion: contract.Version,
	}
}

// Script is the shell run on the hypervisor. `V` tries virsh directly, then via passwordless sudo.
func Script() string {
	s := "set +e; export LC_ALL=C;\n" +
		"V() { virsh \"$@\" 2>/dev/null || sudo -n virsh \"$@\" 2>/dev/null; }\n" +
		sshexec.MarkerPrintf(keyHostname) + "; hostname;\n" +
		sshexec.MarkerPrintf(keyFQDN) + "; hostname -f 2>/dev/null || hostname;\n" +
		sshexec.MarkerPrintf(keyVersion) + "; V version --daemon;\n" +
		sshexec.MarkerPrintf(keyNodeinfo) + "; V nodeinfo;\n" +
		sshexec.MarkerPrintf(keyDmi) + "; for k in product_uuid product_serial sys_vendor product_name; do printf '%s=%s\\n' \"$k\" \"$(cat /sys/class/dmi/id/$k 2>/dev/null)\"; done;\n" +
		sshexec.MarkerPrintf(keyPools) + "; V pool-list --all --details;\n" +
		sshexec.MarkerPrintf(keyNets) + "; V net-list --all;\n" +
		sshexec.MarkerPrintf(keyList) + "; V list --all --uuid;\n" +
		"for u in $(V list --all --uuid); do\n" +
		"  printf '\\n" + sshexec.Marker(prefixDom+"%s") + "\\n' \"$u\"; V dominfo \"$u\";\n" +
		"  printf '\\n" + sshexec.Marker(prefixIfs+"%s") + "\\n' \"$u\"; V domiflist \"$u\";\n" +
		"  printf '\\n" + sshexec.Marker(prefixBlk+"%s") + "\\n' \"$u\"; V domblklist --details \"$u\";\n" +
		"  printf '\\n" + sshexec.Marker(prefixAddr+"%s") + "\\n' \"$u\"; V domifaddr --source agent \"$u\" || V domifaddr --source lease \"$u\";\n" +
		"  printf '\\n" + sshexec.Marker(prefixOS+"%s") + "\\n' \"$u\"; V guestinfo --os \"$u\";\n" +
		"  printf '\\n" + sshexec.Marker(prefixHost+"%s") + "\\n' \"$u\"; V guestinfo --hostname \"$u\";\n" +
		"done\n"
	return s
}

// Assemble turns split script output into the node and its domains.
func Assemble(sections map[string]string, order []string) (Node, []Domain) {
	n := Node{Hostname: strings.TrimSpace(sections[keyHostname]), FQDN: strings.TrimSpace(sections[keyFQDN])}
	ParseVersion(sections[keyVersion], &n)
	ParseNodeinfo(sections[keyNodeinfo], &n)
	ParseDmi(sections[keyDmi], &n)
	n.Pools = ParsePoolList(sections[keyPools])
	n.Networks = ParseNetList(sections[keyNets])
	byUUID := map[string]*Domain{}
	var domains []*Domain
	for _, key := range order {
		kind, uuid, ok := strings.Cut(key, ":")
		if !ok {
			continue
		}
		uuid = strings.ToLower(uuid)
		d, exists := byUUID[uuid]
		if !exists {
			d = &Domain{UUID: uuid, Guest: map[string]string{}}
			byUUID[uuid] = d
			domains = append(domains, d)
		}
		text := sections[key]
		switch kind + ":" {
		case prefixDom:
			ParseDominfo(text, d)
		case prefixIfs:
			d.Interfaces = ParseDomiflist(text)
		case prefixBlk:
			d.Disks = ParseDomblklist(text)
		case prefixAddr:
			d.Addresses = ParseDomifaddr(text)
		case prefixOS:
			for k, v := range ParseGuestinfo(text) {
				d.Guest[k] = v
			}
		case prefixHost:
			for k, v := range ParseGuestinfo(text) {
				d.Guest[k] = v
			}
		}
	}
	out := make([]Domain, 0, len(domains))
	for _, d := range domains {
		out = append(out, *d)
	}
	return n, out
}

func stateOf(s string) string {
	switch {
	case strings.HasPrefix(s, "running"):
		return "running"
	case strings.HasPrefix(s, "paused"):
		return "paused"
	case strings.HasPrefix(s, "shut off"):
		return "stopped"
	default:
		return strings.TrimSpace(s)
	}
}

func osFamily(id, pretty string) string {
	s := strings.ToLower(id + " " + pretty)
	switch {
	case strings.Contains(s, "windows"), strings.Contains(s, "mswindows"):
		return "windows"
	case strings.Contains(s, "freebsd"):
		return "freebsd"
	default:
		return "linux"
	}
}

// Emit converts the node and domains into contract observations.
func Emit(n Node, domains []Domain, target contract.Target, raw []byte, hostKey string, at time.Time) collector.Observation {
	obs := collector.Observation{Evidence: []collector.RawEvidence{{Kind: evidenceKind, Data: raw}}}
	hostRef := firstNonEmpty(n.FQDN, n.Hostname, target.Value)
	hostIdentity := map[string]string{"fqdn": hostRef}
	if n.ProductUUID != "" {
		hostIdentity["systemUuid"] = n.ProductUUID
	}
	if n.ProductSerial != "" {
		hostIdentity["serialNumber"] = n.ProductSerial
	}
	host := contract.CiRef{Type: typeHost, Identity: hostIdentity}
	hostAttrs := map[string]any{"vendor": n.Vendor, "model": n.Product, "cpuModel": n.CPUModel, "cpuCount": n.CPUs, "memoryMb": n.MemoryKiB / kib, "managementIp": target.Value}
	if hostKey != "" {
		hostAttrs["sshHostKeySha256"] = hostKey
	}
	obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeHost, Identity: hostIdentity, Name: hostRef, Attributes: hostAttrs, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
	var poolBytes int64
	poolNames := []string{}
	for _, p := range n.Pools {
		poolBytes += BytesOf(p.Capacity)
		poolNames = append(poolNames, p.Name)
	}
	hvIdentity := map[string]string{"platform": platform, "hostRef": hostRef, "moRef": firstNonEmpty(n.ProductUUID, hostRef)}
	hv := contract.CiRef{Type: typeHypervisor, Identity: hvIdentity}
	obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeHypervisor, Identity: hvIdentity, Name: hostRef,
		Attributes: map[string]any{"platform": platform, "libvirtVersion": n.LibvirtVersion, "hypervisor": n.QemuVersion, "domainCount": len(domains), "storagePools": poolNames, "storagePoolCapacityBytes": poolBytes, "networks": n.Networks, "managementIp": target.Value},
		Tags:       []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
	obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relHostedOn, From: hv, To: host, Attributes: map[string]any{}, ObservedAt: at})
	for _, d := range domains {
		identity := map[string]string{"instanceUuid": d.UUID, "hypervisorRef": hostRef}
		if h := strings.ToLower(d.Guest["hostname"]); h != "" {
			identity["fqdn"] = h
		}
		macs := []string{}
		nets := []string{}
		for _, i := range d.Interfaces {
			macs = append(macs, i.MAC)
			nets = append(nets, i.Source)
		}
		disks := []string{}
		for _, b := range d.Disks {
			if b.Device == "disk" && b.Source != "-" {
				disks = append(disks, b.Source)
			}
		}
		vmRef := contract.CiRef{Type: typeVM, Identity: identity}
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeVM, Identity: identity, Name: d.Name,
			Attributes: map[string]any{"platform": platform, "powerState": stateOf(d.State), "cpuCount": d.VCPUs, "memoryMb": d.MaxMemKiB / kib, "memoryUsedMb": d.UsedMemKiB / kib, "osType": d.OSType, "autostart": d.Autostart, "persistent": d.Persistent, "macAddresses": macs, "networks": nets, "disks": disks, "diskCount": len(disks), "hypervisor": hostRef, "libvirtId": d.ID},
			Tags:       []string{}, ExternalIDs: []contract.ExternalID{{Source: collectorID, ID: d.UUID}}, ObservedAt: at})
		obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relRunsOn, From: vmRef, To: hv, Attributes: map[string]any{}, ObservedAt: at})
		if pretty := firstNonEmpty(d.Guest["os.pretty-name"], d.Guest["os.name"]); pretty != "" {
			osIdentity := map[string]string{"hostRef": d.UUID, "family": osFamily(d.Guest["os.id"], pretty), "version": firstNonEmpty(d.Guest["os.version-id"], d.Guest["os.version"], pretty)}
			obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeOS, Identity: osIdentity, Name: pretty, Attributes: map[string]any{"family": osIdentity["family"], "kernel": d.Guest["os.kernel-release"], "distribution": d.Guest["os.id"], "source": "qemu-guest-agent"}, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
			obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relInstalledOn, From: contract.CiRef{Type: typeOS, Identity: osIdentity}, To: vmRef, Attributes: map[string]any{}, ObservedAt: at})
		}
		for _, a := range d.Addresses {
			addr, _, _ := strings.Cut(a.Address, "/")
			if addr == "" || strings.HasPrefix(addr, "127.") || strings.HasPrefix(addr, "::1") || strings.HasPrefix(strings.ToLower(addr), "fe80:") {
				continue
			}
			ipIdentity := map[string]string{"address": addr, "vrfRef": "default"}
			obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeIP, Identity: ipIdentity, Name: addr, Attributes: map[string]any{"cidr": a.Address, "mac": a.MAC, "interface": a.Interface, "assignedTo": d.Name}, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
			obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relUsesIP, From: vmRef, To: contract.CiRef{Type: typeIP, Identity: ipIdentity}, Attributes: map[string]any{}, ObservedAt: at})
		}
	}
	return obs
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

func (Collector) Collect(ctx context.Context, target contract.Target, cred *contract.Credential, options map[string]any) (collector.Observation, error) {
	out, err := sshexec.Run(ctx, target, cred, options, Script())
	if err != nil {
		return collector.Observation{}, err
	}
	sections, order := sshexec.Split(string(out.Stdout))
	if strings.TrimSpace(sections[keyVersion]) == "" && strings.TrimSpace(sections[keyList]) == "" {
		return collector.Observation{}, collector.Errorf(contract.ErrUnsupportedDevice, false, "%s has no usable virsh (not a libvirt host, or sudo -n denied)", target.Value)
	}
	n, domains := Assemble(sections, order)
	return Emit(n, domains, target, out.Stdout, out.HostKey, time.Now().UTC()), nil
}
