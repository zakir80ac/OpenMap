// REQ-DISC-009 REQ-DISC-007 — oVirt / Oracle Linux Virtualization Manager (OLVM) / RHV collector
// over the ovirt-engine REST API: data centres, clusters, hosts (with the physical server), VMs
// with guest OS, NIC MACs and agent-reported addresses, and storage domains as LUNs or NAS shares.
// One target = one engine. `platform` names the product for identities: ovirt (default), oracle_vm, rhv.
package ovirt

import (
	"context"
	"strconv"
	"strings"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/collector"
	"github.com/openmap/openmap/apps/collectors/internal/contract"
	"github.com/openmap/openmap/apps/collectors/internal/restjson"
)

const (
	collectorID     = "oracle_vm"
	version         = "0.1.0"
	evidenceKind    = "api_response"
	defaultPort     = 443
	optionVerify    = "verifyTls"
	optionCA        = "caCertPem"
	optionPlatform  = "platform"
	defaultPlatform = "ovirt"
	credUser        = "username"
	credPassword    = "password"
	apiBase         = "/ovirt-engine/api"
	defaultVrf      = "default"
	bytesPerMiB     = 1 << 20

	typeCluster    = "vm_cluster"
	typeHypervisor = "hypervisor"
	typeHost       = "host"
	typeVM         = "vm"
	typeOS         = "operating_system"
	typeIP         = "ip_address"
	typeLun        = "lun"
	typeNas        = "nas_share"
	relMemberOf    = "member_of"
	relHostedOn    = "hosted_on"
	relRunsOn      = "runs_on"
	relInstalledOn = "installed_on"
	relUsesIP      = "uses_ip"
	relMountedOn   = "mounted_on"
)

type Collector struct{}

func (Collector) Manifest() contract.Manifest {
	return contract.Manifest{
		ID: collectorID, Family: "oracle_vm", Version: version, Language: "go",
		Protocols: []string{"https"}, CredentialTypes: []string{"password"},
		TargetKinds: []string{"host"}, Emits: []string{typeCluster, typeHypervisor, typeHost, typeVM, typeOS, typeIP, typeLun, typeNas},
		ContractVersion: contract.Version,
	}
}

type ref struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type apiRoot struct {
	ProductInfo struct {
		Name    string `json:"name"`
		Vendor  string `json:"vendor"`
		Version struct {
			FullVersion string `json:"full_version"`
		} `json:"version"`
	} `json:"product_info"`
}

type dataCenter struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Status string `json:"status"`
}

type cluster struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	DataCenter ref    `json:"data_center"`
	CPU        struct {
		Type string `json:"type"`
	} `json:"cpu"`
	Version struct {
		Major string `json:"major"`
		Minor string `json:"minor"`
	} `json:"version"`
}

type host struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Address  string `json:"address"`
	Status   string `json:"status"`
	Cluster  ref    `json:"cluster"`
	Memory   string `json:"memory"`
	Hardware struct {
		SerialNumber string `json:"serial_number"`
		Manufacturer string `json:"manufacturer"`
		ProductName  string `json:"product_name"`
		UUID         string `json:"uuid"`
	} `json:"hardware_information"`
	CPU struct {
		Name     string `json:"name"`
		Topology struct {
			Sockets string `json:"sockets"`
			Cores   string `json:"cores"`
			Threads string `json:"threads"`
		} `json:"topology"`
	} `json:"cpu"`
	OS struct {
		Type    string `json:"type"`
		Version struct {
			FullVersion string `json:"full_version"`
		} `json:"version"`
	} `json:"os"`
	Version struct {
		FullVersion string `json:"full_version"`
	} `json:"version"`
	LibvirtVersion struct {
		FullVersion string `json:"full_version"`
	} `json:"libvirt_version"`
}

type ipDoc struct {
	Address string `json:"address"`
	Version string `json:"version"`
}

type nic struct {
	Name string `json:"name"`
	MAC  struct {
		Address string `json:"address"`
	} `json:"mac"`
	ReportedDevices struct {
		ReportedDevice []struct {
			IPs struct {
				IP []ipDoc `json:"ip"`
			} `json:"ips"`
		} `json:"reported_device"`
	} `json:"reported_devices"`
}

type diskAttachment struct {
	Disk struct {
		ID              string `json:"id"`
		Name            string `json:"name"`
		ProvisionedSize string `json:"provisioned_size"`
		ActualSize      string `json:"actual_size"`
		StorageDomains  struct {
			StorageDomain []ref `json:"storage_domain"`
		} `json:"storage_domains"`
	} `json:"disk"`
}

type vm struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Status  string `json:"status"`
	FQDN    string `json:"fqdn"`
	Host    ref    `json:"host"`
	Cluster ref    `json:"cluster"`
	Memory  string `json:"memory"`
	CPU     struct {
		Topology struct {
			Sockets string `json:"sockets"`
			Cores   string `json:"cores"`
			Threads string `json:"threads"`
		} `json:"topology"`
	} `json:"cpu"`
	OS struct {
		Type string `json:"type"`
	} `json:"os"`
	GuestOS struct {
		Distribution string `json:"distribution"`
		Family       string `json:"family"`
		Version      struct {
			FullVersion string `json:"full_version"`
		} `json:"version"`
	} `json:"guest_operating_system"`
	Nics struct {
		Nic []nic `json:"nic"`
	} `json:"nics"`
	DiskAttachments struct {
		DiskAttachment []diskAttachment `json:"disk_attachment"`
	} `json:"disk_attachments"`
}

type storageDomain struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Type      string `json:"type"`
	Available string `json:"available"`
	Used      string `json:"used"`
	Committed string `json:"committed"`
	Storage   struct {
		Type    string `json:"type"`
		Address string `json:"address"`
		Path    string `json:"path"`
	} `json:"storage"`
}

// Inventory is one engine's content.
type Inventory struct {
	Root           apiRoot
	DataCenters    []dataCenter
	Clusters       []cluster
	Hosts          []host
	VMs            []vm
	StorageDomains []storageDomain
	Raw            [][]byte
}

// Walk reads the engine. The VM listing follows NICs (with reported addresses) and disk attachments.
func Walk(ctx context.Context, c *restjson.Client) (*Inventory, error) {
	inv := &Inventory{}
	if err := c.Get(ctx, apiBase, &inv.Root); err != nil {
		return nil, err
	}
	var dcs struct {
		DataCenter []dataCenter `json:"data_center"`
	}
	if err := c.Get(ctx, apiBase+"/datacenters", &dcs); err != nil {
		return nil, err
	}
	inv.DataCenters = dcs.DataCenter
	var cls struct {
		Cluster []cluster `json:"cluster"`
	}
	if err := c.Get(ctx, apiBase+"/clusters", &cls); err != nil {
		return nil, err
	}
	inv.Clusters = cls.Cluster
	var hosts struct {
		Host []host `json:"host"`
	}
	if err := c.Get(ctx, apiBase+"/hosts", &hosts); err != nil {
		return nil, err
	}
	inv.Hosts = hosts.Host
	var vms struct {
		VM []vm `json:"vm"`
	}
	if err := c.Get(ctx, apiBase+"/vms?follow=nics.reported_devices,disk_attachments.disk", &vms); err != nil {
		return nil, err
	}
	inv.VMs = vms.VM
	var sds struct {
		StorageDomain []storageDomain `json:"storage_domain"`
	}
	if err := c.Get(ctx, apiBase+"/storagedomains", &sds); err == nil {
		inv.StorageDomains = sds.StorageDomain
	}
	inv.Raw = c.Raw()
	return inv, nil
}

func atoi(s string) int {
	n, _ := strconv.Atoi(s)
	return n
}

func atoi64(s string) int64 {
	n, _ := strconv.ParseInt(s, 10, 64)
	return n
}

func vcpus(sockets, cores, threads string) int {
	n := atoi(sockets) * atoi(cores) * atoi(threads)
	if n == 0 {
		n = atoi(sockets) * atoi(cores)
	}
	return n
}

func powerState(status string) string {
	switch strings.ToLower(status) {
	case "up":
		return "running"
	case "down":
		return "stopped"
	case "paused", "suspended":
		return "paused"
	default:
		return strings.ToLower(status)
	}
}

// Emit converts the inventory into contract observations.
func Emit(inv *Inventory, target contract.Target, platform string, at time.Time) collector.Observation {
	obs := collector.Observation{}
	for _, r := range inv.Raw {
		obs.Evidence = append(obs.Evidence, collector.RawEvidence{Kind: evidenceKind, Data: r})
	}
	engine := strings.ToLower(target.Value)
	dcName := map[string]string{}
	for _, dc := range inv.DataCenters {
		dcName[dc.ID] = dc.Name
	}
	clusterRef := map[string]contract.CiRef{}
	for _, cl := range inv.Clusters {
		identity := map[string]string{"platform": platform, "clusterId": cl.ID}
		clusterRef[cl.ID] = contract.CiRef{Type: typeCluster, Identity: identity}
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeCluster, Identity: identity, Name: cl.Name,
			Attributes: map[string]any{"platform": platform, "engine": engine, "engineProduct": inv.Root.ProductInfo.Name, "engineVersion": inv.Root.ProductInfo.Version.FullVersion, "dataCenter": dcName[cl.DataCenter.ID], "cpuType": cl.CPU.Type, "compatibilityVersion": cl.Version.Major + "." + cl.Version.Minor},
			Tags:       []string{}, ExternalIDs: []contract.ExternalID{{Source: platform, ID: cl.ID}}, ObservedAt: at})
	}
	hvRef := map[string]contract.CiRef{}
	for _, h := range inv.Hosts {
		hostRef := strings.ToLower(firstNonEmpty(h.Address, h.Name))
		hostIdentity := map[string]string{"fqdn": hostRef}
		if h.Hardware.SerialNumber != "" {
			hostIdentity["serialNumber"] = h.Hardware.SerialNumber
		}
		if h.Hardware.UUID != "" {
			hostIdentity["systemUuid"] = strings.ToLower(h.Hardware.UUID)
		}
		hostCi := contract.CiRef{Type: typeHost, Identity: hostIdentity}
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeHost, Identity: hostIdentity, Name: hostRef,
			Attributes: map[string]any{"manufacturer": h.Hardware.Manufacturer, "model": h.Hardware.ProductName, "cpuModel": h.CPU.Name, "cpuCount": vcpus(h.CPU.Topology.Sockets, h.CPU.Topology.Cores, h.CPU.Topology.Threads), "memoryMb": atoi64(h.Memory) / bytesPerMiB, "managementIp": h.Address, "engineHostId": h.ID},
			Tags:       []string{}, ExternalIDs: []contract.ExternalID{{Source: platform, ID: h.ID}}, ObservedAt: at})
		hvIdentity := map[string]string{"platform": platform, "hostRef": hostRef, "moRef": h.ID}
		hv := contract.CiRef{Type: typeHypervisor, Identity: hvIdentity}
		hvRef[h.ID] = hv
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeHypervisor, Identity: hvIdentity, Name: h.Name,
			Attributes: map[string]any{"platform": platform, "status": h.Status, "connectionState": h.Status, "hostOs": h.OS.Type, "hostOsVersion": h.OS.Version.FullVersion, "vdsmVersion": h.Version.FullVersion, "libvirtVersion": h.LibvirtVersion.FullVersion, "cluster": h.Cluster.ID, "engine": engine},
			Tags:       []string{}, ExternalIDs: []contract.ExternalID{{Source: platform, ID: h.ID}}, ObservedAt: at})
		obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relHostedOn, From: hv, To: hostCi, Attributes: map[string]any{}, ObservedAt: at})
		if cl, ok := clusterRef[h.Cluster.ID]; ok {
			obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relMemberOf, From: hv, To: cl, Attributes: map[string]any{}, ObservedAt: at})
		}
	}
	domainRef := map[string]contract.CiRef{}
	for _, sd := range inv.StorageDomains {
		var t string
		var identity map[string]string
		switch strings.ToLower(sd.Storage.Type) {
		case "nfs", "glusterfs", "posixfs":
			t = typeNas
			identity = map[string]string{"arrayRef": firstNonEmpty(sd.Storage.Address, engine), "protocol": strings.ToLower(sd.Storage.Type), "path": firstNonEmpty(sd.Storage.Path, sd.Name)}
		default:
			t = typeLun
			identity = map[string]string{"arrayRef": engine, "wwn": engine + ":" + sd.ID}
		}
		ref := contract.CiRef{Type: t, Identity: identity}
		domainRef[sd.ID] = ref
		used := atoi64(sd.Used)
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: t, Identity: identity, Name: sd.Name,
			Attributes: map[string]any{"platform": platform, "engine": engine, "domainType": sd.Type, "storageType": sd.Storage.Type, "address": sd.Storage.Address, "capacityBytes": atoi64(sd.Available) + used, "usedBytes": used, "committedBytes": atoi64(sd.Committed)},
			Tags:       []string{}, ExternalIDs: []contract.ExternalID{{Source: platform, ID: sd.ID}}, ObservedAt: at})
	}
	for _, v := range inv.VMs {
		hv, placed := hvRef[v.Host.ID]
		// A VM that is down runs on no host: identity values are never empty, so hypervisorRef is set only
		// while the engine places the VM on a host.
		identity := map[string]string{"instanceUuid": strings.ToLower(v.ID)}
		if placed {
			identity["hypervisorRef"] = hv.Identity["hostRef"]
		}
		if v.FQDN != "" {
			identity["fqdn"] = strings.ToLower(v.FQDN)
		}
		macs := []string{}
		var addresses []ipDoc
		for _, n := range v.Nics.Nic {
			if n.MAC.Address != "" {
				macs = append(macs, strings.ToLower(n.MAC.Address))
			}
			for _, rd := range n.ReportedDevices.ReportedDevice {
				addresses = append(addresses, rd.IPs.IP...)
			}
		}
		var provisioned, actual int64
		domains := map[string]bool{}
		for _, da := range v.DiskAttachments.DiskAttachment {
			provisioned += atoi64(da.Disk.ProvisionedSize)
			actual += atoi64(da.Disk.ActualSize)
			for _, sd := range da.Disk.StorageDomains.StorageDomain {
				domains[sd.ID] = true
			}
		}
		vmRef := contract.CiRef{Type: typeVM, Identity: identity}
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeVM, Identity: identity, Name: v.Name,
			Attributes: map[string]any{"platform": platform, "engine": engine, "powerState": powerState(v.Status), "cpuCount": vcpus(v.CPU.Topology.Sockets, v.CPU.Topology.Cores, v.CPU.Topology.Threads), "memoryMb": atoi64(v.Memory) / bytesPerMiB, "osType": v.OS.Type, "macAddresses": macs, "diskBytes": provisioned, "diskUsedBytes": actual, "diskCount": len(v.DiskAttachments.DiskAttachment), "cluster": v.Cluster.ID, "hypervisor": hv.Identity["hostRef"]},
			Tags:       []string{}, ExternalIDs: []contract.ExternalID{{Source: platform, ID: v.ID}}, ObservedAt: at})
		if hv.Type != "" {
			obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relRunsOn, From: vmRef, To: hv, Attributes: map[string]any{}, ObservedAt: at})
		}
		for id := range domains {
			if d, ok := domainRef[id]; ok {
				obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relMountedOn, From: vmRef, To: d, Attributes: map[string]any{}, ObservedAt: at})
			}
		}
		if dist := firstNonEmpty(v.GuestOS.Distribution, v.OS.Type); dist != "" && v.GuestOS.Family != "" {
			osIdentity := map[string]string{"hostRef": identity["instanceUuid"], "family": strings.ToLower(v.GuestOS.Family), "version": firstNonEmpty(v.GuestOS.Version.FullVersion, dist)}
			obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeOS, Identity: osIdentity, Name: dist + " " + v.GuestOS.Version.FullVersion, Attributes: map[string]any{"family": osIdentity["family"], "distribution": dist, "source": "ovirt-guest-agent"}, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
			obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relInstalledOn, From: contract.CiRef{Type: typeOS, Identity: osIdentity}, To: vmRef, Attributes: map[string]any{}, ObservedAt: at})
		}
		seen := map[string]bool{}
		for _, a := range addresses {
			if a.Address == "" || seen[a.Address] || strings.HasPrefix(strings.ToLower(a.Address), "fe80:") || strings.HasPrefix(a.Address, "127.") {
				continue
			}
			seen[a.Address] = true
			ipIdentity := map[string]string{"address": a.Address, "vrfRef": defaultVrf}
			obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeIP, Identity: ipIdentity, Name: a.Address, Attributes: map[string]any{"assignedTo": v.Name, "ipVersion": a.Version, "source": collectorID}, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
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
	if cred == nil || cred.Type != "password" || cred.Fields[credUser] == "" {
		return collector.Observation{}, collector.Errorf(contract.ErrAuthFailed, false, "ovirt requires a password credential (e.g. admin@internal)")
	}
	platform := strings.ToLower(firstNonEmpty(restjson.StringOption(options, optionPlatform), defaultPlatform))
	c, err := restjson.New(target.Value, defaultPort, restjson.Auth{User: cred.Fields[credUser], Pass: cred.Fields[credPassword]}, restjson.Options{VerifyTLS: restjson.BoolOption(options, optionVerify), CAPem: restjson.StringOption(options, optionCA), Headers: map[string]string{"Version": "4"}})
	if err != nil {
		return collector.Observation{}, err
	}
	inv, err := Walk(ctx, c)
	if err != nil {
		return collector.Observation{}, restjson.Classify(target.Value, err)
	}
	return Emit(inv, target, platform, time.Now().UTC()), nil
}
