// REQ-DISC-003 — assembles Facts from split command output and emits contract observations:
// host (or vm), operating_system, interfaces, ip_address, listening_service, software_instance,
// plus runs_on/uses_ip/installed_on/contains relationships.
package sshlinux

import (
	"net"
	"strconv"
	"strings"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/collector"
	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

const (
	typeHost      = "host"
	typeVM        = "vm"
	typeOS        = "operating_system"
	typeInterface = "interface"
	typeIP        = "ip_address"
	typeListener  = "listening_service"
	typeSoftware  = "software"
	typeInstall   = "software_instance"

	relContains  = "contains"
	relUsesIP    = "uses_ip"
	relRunsOn    = "runs_on"
	relInstalled = "installed_on"

	evidenceKind = "cli_output"
	familyLinux  = "linux"
	// Only packages in this allow-list become software CIs by default; the rest stay in attributes.
	// Everything a security or licence team asks about is here; the list is extended per tenant.
	maxPackagesInAttributes = 5000
)

var interestingPackages = map[string]bool{
	"openssl": true, "openssh-server": true, "nginx": true, "apache2": true, "httpd": true, "postgresql": true, "postgresql-16": true, "postgresql-15": true,
	"mysql-server": true, "mariadb-server": true, "redis-server": true, "redis": true, "docker-ce": true, "containerd.io": true, "kubelet": true,
	"java-17-openjdk": true, "openjdk-17-jre": true, "openjdk-21-jre": true, "nodejs": true, "python3": true, "haproxy": true, "keepalived": true,
	"patroni": true, "etcd": true, "kafka": true, "elasticsearch": true, "mongodb-org-server": true, "glibc": true, "libc6": true, "sudo": true, "systemd": true,
}

// Assemble builds Facts from the split outputs.
func Assemble(parts map[string]string) Facts {
	var f Facts
	f.Hostname = strings.TrimSpace(parts["hostname"])
	f.FQDN = strings.TrimSpace(parts["fqdn"])
	f.MachineID = strings.TrimSpace(parts["machine_id"])
	f.OS = ParseOSRelease(parts["os_release"])
	f.Kernel = strings.TrimSpace(parts["kernel"])
	f.Arch = strings.TrimSpace(parts["arch"])
	f.Uptime = ParseUptime(parts["uptime"])
	f.CPUCount, f.CPUModel = ParseCPUInfo(parts["cpuinfo"])
	f.MemoryKB = ParseMeminfo(parts["meminfo"])
	ParseDMI(parts["dmi"], &f)
	f.Interfaces = ParseIPAddr(parts["ip_addr"])
	f.Listeners = ParseSS(parts["ss"])
	f.Packages = ParsePackages(parts["packages"])
	f.Disks = ParseLsblk(parts["lsblk"])
	f.Mounts = ParseDF(parts["df"])
	f.Components = Components(parts)
	f.Utilisation = MeasureUtilisation(parts, f.Mounts)
	return f
}

func primaryMAC(f Facts) string {
	for _, i := range f.Interfaces {
		if i.MAC != "" && i.State == "up" && len(i.Addrs) > 0 {
			return i.MAC
		}
	}
	for _, i := range f.Interfaces {
		if i.MAC != "" {
			return i.MAC
		}
	}
	return ""
}

// Emit converts Facts into an Observation.
func Emit(f Facts, target contract.Target, raw []byte, at time.Time) collector.Observation {
	obs := collector.Observation{Evidence: []collector.RawEvidence{{Kind: evidenceKind, Data: raw}}}
	hostType := typeHost
	identity := map[string]string{}
	if f.Virtual != "" && f.Virtual != "unknown" {
		hostType = typeVM
		if f.ProductUUID != "" {
			identity["instanceUuid"] = f.ProductUUID
		}
		if f.FQDN != "" {
			identity["fqdn"] = f.FQDN
		}
		identity["hypervisorRef"] = f.Virtual
	} else {
		if f.Serial != "" {
			identity["serialNumber"] = f.Serial
		}
		if f.ProductUUID != "" {
			identity["systemUuid"] = f.ProductUUID
		}
		if f.FQDN != "" {
			identity["fqdn"] = f.FQDN
		}
		if mac := primaryMAC(f); mac != "" {
			identity["primaryMac"] = mac
		}
	}
	if len(identity) == 0 {
		identity["fqdn"] = firstNonEmpty(f.FQDN, f.Hostname, target.Value)
	}
	hostRef := firstNonEmpty(f.Serial, f.ProductUUID, f.FQDN, f.Hostname, target.Value)
	hostCiRef := contract.CiRef{Type: hostType, Identity: identity}
	name := firstNonEmpty(f.FQDN, f.Hostname, target.Value)
	pkgNames := make([]string, 0, len(f.Packages))
	for i, p := range f.Packages {
		if i >= maxPackagesInAttributes {
			break
		}
		pkgNames = append(pkgNames, p.Name+" "+p.Version)
	}
	attrs := map[string]any{
		"hostname": f.Hostname, "fqdn": f.FQDN, "machineId": f.MachineID, "managementIp": target.Value,
		"manufacturer": f.Manufacturer, "model": f.Model, "biosVersion": f.BIOSVersion, "virtualization": f.Virtual,
		"kernel": f.Kernel, "arch": f.Arch, "cpuCount": f.CPUCount, "cpuModel": f.CPUModel, "memoryGb": f.MemoryKB / 1024 / 1024,
		"uptimeSeconds": int64(f.Uptime), "diskCount": len(f.Disks), "packageCount": len(f.Packages), "packages": pkgNames,
	}
	if len(f.Disks) > 0 {
		disks := make([]string, 0, len(f.Disks))
		for _, d := range f.Disks {
			disks = append(disks, d.Name+" "+d.Size+" "+d.Model)
		}
		attrs["disks"] = disks
	}
	obs.Cis = append(obs.Cis, contract.ObservedCi{Type: hostType, Identity: identity, Name: name, Attributes: attrs, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at, Components: f.Components})
	obs.Samples = f.Utilisation.Samples(hostCiRef, at)

	if f.OS.ID != "" || f.OS.Pretty != "" {
		osIdentity := map[string]string{"hostRef": hostRef, "family": OSFamily(f.OS.ID), "version": firstNonEmpty(f.OS.VersionID, f.OS.Version, f.Kernel)}
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeOS, Identity: osIdentity, Name: firstNonEmpty(f.OS.Pretty, f.OS.Name), Attributes: map[string]any{"id": f.OS.ID, "distribution": f.OS.ID, "version": f.OS.Version, "versionId": f.OS.VersionID, "kernel": f.Kernel, "arch": f.Arch}, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
		obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relRunsOn, From: contract.CiRef{Type: typeOS, Identity: osIdentity}, To: hostCiRef, Attributes: map[string]any{}, ObservedAt: at})
	}

	for idx, i := range f.Interfaces {
		ifIdentity := map[string]string{"deviceRef": hostRef, "ifIndex": strconv.Itoa(idx + 1), "name": i.Name}
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeInterface, Identity: ifIdentity, Name: i.Name, Attributes: map[string]any{"mac": i.MAC, "state": i.State, "mtu": i.MTU, "addresses": i.Addrs}, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
		ifRef := contract.CiRef{Type: typeInterface, Identity: ifIdentity}
		obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relContains, From: hostCiRef, To: ifRef, Attributes: map[string]any{}, ObservedAt: at})
		for _, cidr := range i.Addrs {
			addr := strings.SplitN(cidr, "/", 2)[0]
			if strings.HasPrefix(addr, "fe80:") || strings.HasPrefix(addr, "127.") || addr == "::1" {
				continue
			}
			ipIdentity := map[string]string{"address": addr}
			obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeIP, Identity: ipIdentity, Name: addr, Attributes: map[string]any{"cidr": cidr, "interface": i.Name, "assignedTo": hostRef}, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
			obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relUsesIP, From: ifRef, To: contract.CiRef{Type: typeIP, Identity: ipIdentity}, Attributes: map[string]any{}, ObservedAt: at})
		}
	}

	// One listening_service per protocol/port: the IPv4 and IPv6 wildcard sockets of one daemon share
	// an identity, and loopback-only sockets (the whole 127/8, e.g. Docker's 127.0.0.11 resolver) are not services.
	emittedListeners := map[string]bool{}
	for _, l := range f.Listeners {
		if ip := net.ParseIP(l.Address); ip != nil && ip.IsLoopback() {
			continue
		}
		listenerKey := l.Proto + "/" + strconv.Itoa(l.Port)
		if emittedListeners[listenerKey] {
			continue
		}
		emittedListeners[listenerKey] = true
		lsIdentity := map[string]string{"hostRef": hostRef, "protocol": l.Proto, "port": strconv.Itoa(l.Port)}
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeListener, Identity: lsIdentity, Name: firstNonEmpty(l.Process, l.Proto+"/"+strconv.Itoa(l.Port)), Attributes: map[string]any{"protocol": l.Proto, "port": l.Port, "address": l.Address, "process": l.Process, "pid": l.PID}, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
		obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relRunsOn, From: contract.CiRef{Type: typeListener, Identity: lsIdentity}, To: hostCiRef, Attributes: map[string]any{}, ObservedAt: at})
	}

	vendor := firstNonEmpty(f.OS.Name, "linux")
	for _, p := range f.Packages {
		if !interestingPackages[p.Name] {
			continue
		}
		swIdentity := map[string]string{"vendor": vendor, "name": p.Name, "version": p.Version}
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeSoftware, Identity: swIdentity, Name: p.Name + " " + p.Version, Attributes: map[string]any{"arch": p.Arch, "packageManager": "os"}, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
		instIdentity := map[string]string{"hostRef": hostRef, "softwareRef": p.Name + "@" + p.Version, "installPath": "os-package"}
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeInstall, Identity: instIdentity, Name: p.Name + " on " + name, Attributes: map[string]any{"version": p.Version}, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
		obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relInstalled, From: contract.CiRef{Type: typeInstall, Identity: instIdentity}, To: hostCiRef, Attributes: map[string]any{}, ObservedAt: at})
	}
	return obs
}

// bsdFamilies are the os-release IDs of non-Linux systems that ship /etc/os-release.
var bsdFamilies = map[string]bool{"freebsd": true, "openbsd": true, "netbsd": true, "dragonfly": true}

// OSFamily is the operating_system identity family: "linux" for every Linux distribution, as the agent, libvirt,
// Kubernetes and Hyper-V collectors and the estate name it, so one host's OS reconciles to one CI whichever
// collector saw it. The distribution's os-release ID stays in the id / distribution attributes.
func OSFamily(osReleaseID string) string {
	id := strings.ToLower(strings.TrimSpace(osReleaseID))
	if bsdFamilies[id] {
		return id
	}
	return familyLinux
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}
