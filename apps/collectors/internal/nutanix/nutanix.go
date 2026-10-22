// REQ-DISC-008 — Nutanix AHV collector over the Prism v3 REST API (Prism Central or Element):
// clusters, hosts (with the physical node, its IPMI BMC and the AHV hypervisor), VMs with NICs,
// IPs and guest OS, subnets and storage containers. One target = one Prism endpoint.
package nutanix

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
	collectorID  = "nutanix_ahv"
	version      = "0.1.0"
	platform     = "nutanix_ahv"
	defaultPort  = 9440
	pageLength   = 500
	optionVerify = "verifyTls"
	optionCA     = "caCertPem"
	credUser     = "username"
	credPassword = "password"
	evidenceKind = "api_response"
	v3           = "/api/nutanix/v3/"
	v2Containers = "/PrismGateway/services/rest/v2.0/storage_containers/"
	defaultVrf   = "default"

	typeCluster    = "vm_cluster"
	typeHypervisor = "hypervisor"
	typeHost       = "host"
	typeBmc        = "bmc"
	typeVM         = "vm"
	typeOS         = "operating_system"
	typeIP         = "ip_address"
	typeSubnet     = "subnet"
	typeVlan       = "vlan"
	typeLun        = "lun"

	relMemberOf    = "member_of"
	relHostedOn    = "hosted_on"
	relManages     = "manages"
	relRunsOn      = "runs_on"
	relInstalledOn = "installed_on"
	relUsesIP      = "uses_ip"
	relInSubnet    = "in_subnet"
	relInVlan      = "in_vlan"
	relMountedOn   = "mounted_on"
)

type Collector struct{}

func (Collector) Manifest() contract.Manifest {
	return contract.Manifest{
		ID: collectorID, Family: "nutanix_ahv", Version: version, Language: "go",
		Protocols: []string{"https"}, CredentialTypes: []string{"password"},
		TargetKinds: []string{"host", "url"}, Emits: []string{typeCluster, typeHypervisor, typeHost, typeBmc, typeVM, typeOS, typeIP, typeSubnet, typeVlan, typeLun},
		ContractVersion: contract.Version,
	}
}

type ref struct {
	Kind string `json:"kind"`
	UUID string `json:"uuid"`
	Name string `json:"name"`
}

type metadata struct {
	UUID string `json:"uuid"`
	Kind string `json:"kind"`
}

type listResponse[T any] struct {
	Entities []T `json:"entities"`
	Metadata struct {
		TotalMatches int `json:"total_matches"`
		Length       int `json:"length"`
		Offset       int `json:"offset"`
	} `json:"metadata"`
}

type clusterEntity struct {
	Metadata metadata `json:"metadata"`
	Status   struct {
		Name      string `json:"name"`
		Resources struct {
			Config struct {
				SoftwareMap map[string]struct {
					Version string `json:"version"`
				} `json:"software_map"`
				Build struct {
					Version string `json:"version"`
				} `json:"build"`
				ServiceList []string `json:"service_list"`
			} `json:"config"`
			Network struct {
				ExternalIP string `json:"external_ip"`
			} `json:"network"`
			Nodes struct {
				HypervisorServerList []struct {
					IP      string `json:"ip"`
					Version string `json:"version"`
					Type    string `json:"type"`
				} `json:"hypervisor_server_list"`
			} `json:"nodes"`
		} `json:"resources"`
	} `json:"status"`
}

type hostEntity struct {
	Metadata metadata `json:"metadata"`
	Status   struct {
		Name             string `json:"name"`
		ClusterReference ref    `json:"cluster_reference"`
		Resources        struct {
			SerialNumber string `json:"serial_number"`
			Block        struct {
				BlockModel        string `json:"block_model"`
				BlockSerialNumber string `json:"block_serial_number"`
			} `json:"block"`
			Hypervisor struct {
				IP                 string `json:"ip"`
				HypervisorFullName string `json:"hypervisor_full_name"`
			} `json:"hypervisor"`
			ControllerVM struct {
				IP string `json:"ip"`
			} `json:"controller_vm"`
			IPMI struct {
				IP string `json:"ip"`
			} `json:"ipmi"`
			NumCPUCores       int    `json:"num_cpu_cores"`
			NumCPUSockets     int    `json:"num_cpu_sockets"`
			MemoryCapacityMib int64  `json:"memory_capacity_mib"`
			CPUModel          string `json:"cpu_model"`
			HostType          string `json:"host_type"`
		} `json:"resources"`
	} `json:"status"`
}

type vmEntity struct {
	Metadata metadata `json:"metadata"`
	Status   struct {
		Name             string `json:"name"`
		ClusterReference ref    `json:"cluster_reference"`
		Resources        struct {
			PowerState        string `json:"power_state"`
			NumSockets        int    `json:"num_sockets"`
			NumVcpusPerSocket int    `json:"num_vcpus_per_socket"`
			MemorySizeMib     int    `json:"memory_size_mib"`
			HostReference     ref    `json:"host_reference"`
			NicList           []struct {
				MacAddress     string `json:"mac_address"`
				IPEndpointList []struct {
					IP string `json:"ip"`
				} `json:"ip_endpoint_list"`
				SubnetReference ref `json:"subnet_reference"`
			} `json:"nic_list"`
			DiskList []struct {
				DiskSizeBytes int64 `json:"disk_size_bytes"`
				StorageConfig struct {
					StorageContainerReference ref `json:"storage_container_reference"`
				} `json:"storage_config"`
				DeviceProperties struct {
					DeviceType string `json:"device_type"`
				} `json:"device_properties"`
			} `json:"disk_list"`
			GuestTools struct {
				NutanixGuestTools struct {
					GuestOSVersion string `json:"guest_os_version"`
					State          string `json:"state"`
				} `json:"nutanix_guest_tools"`
			} `json:"guest_tools"`
		} `json:"resources"`
	} `json:"status"`
}

type subnetEntity struct {
	Metadata metadata `json:"metadata"`
	Status   struct {
		Name             string `json:"name"`
		ClusterReference ref    `json:"cluster_reference"`
		Resources        struct {
			SubnetType string `json:"subnet_type"`
			VlanID     int    `json:"vlan_id"`
			IPConfig   struct {
				SubnetIP         string `json:"subnet_ip"`
				PrefixLength     int    `json:"prefix_length"`
				DefaultGatewayIP string `json:"default_gateway_ip"`
			} `json:"ip_config"`
		} `json:"resources"`
	} `json:"status"`
}

type containerEntity struct {
	StorageContainerUUID string            `json:"storage_container_uuid"`
	ClusterUUID          string            `json:"cluster_uuid"`
	Name                 string            `json:"name"`
	MaxCapacity          int64             `json:"max_capacity"`
	UsageStats           map[string]string `json:"usage_stats"`
	ReplicationFactor    int               `json:"replication_factor"`
	CompressionEnabled   bool              `json:"compression_enabled"`
}

type v2List struct {
	Entities []containerEntity `json:"entities"`
}

// Inventory is the Prism content Walk gathered.
type Inventory struct {
	Clusters   []clusterEntity
	Hosts      []hostEntity
	VMs        []vmEntity
	Subnets    []subnetEntity
	Containers []containerEntity
	Raw        [][]byte
}

func listAll[T any](ctx context.Context, c *restjson.Client, kind string, out *[]T) error {
	for offset := 0; ; offset += pageLength {
		var page listResponse[T]
		if err := c.Post(ctx, v3+kind+"s/list", map[string]any{"kind": kind, "length": pageLength, "offset": offset}, &page); err != nil {
			return err
		}
		*out = append(*out, page.Entities...)
		if len(page.Entities) < pageLength {
			return nil
		}
	}
}

// Walk lists clusters, hosts, VMs and subnets through v3 and storage containers through v2 (optional).
func Walk(ctx context.Context, c *restjson.Client) (*Inventory, error) {
	inv := &Inventory{}
	if err := listAll(ctx, c, "cluster", &inv.Clusters); err != nil {
		return nil, err
	}
	if err := listAll(ctx, c, "host", &inv.Hosts); err != nil {
		return nil, err
	}
	if err := listAll(ctx, c, "vm", &inv.VMs); err != nil {
		return nil, err
	}
	if err := listAll(ctx, c, "subnet", &inv.Subnets); err != nil {
		return nil, err
	}
	var containers v2List
	if err := c.Get(ctx, v2Containers, &containers); err == nil {
		inv.Containers = containers.Entities
	}
	inv.Raw = c.Raw()
	return inv, nil
}

func osFamily(guest string) string {
	g := strings.ToLower(guest)
	switch {
	case strings.Contains(g, "windows"):
		return "windows"
	case g == "":
		return ""
	default:
		return "linux"
	}
}

// Emit converts the inventory into contract observations.
func Emit(inv *Inventory, target contract.Target, at time.Time) collector.Observation {
	obs := collector.Observation{}
	for _, raw := range inv.Raw {
		obs.Evidence = append(obs.Evidence, collector.RawEvidence{Kind: evidenceKind, Data: raw})
	}
	clusterRef := map[string]contract.CiRef{}
	clusterName := map[string]string{}
	for _, cl := range inv.Clusters {
		uuid := cl.Metadata.UUID
		identity := map[string]string{"platform": platform, "clusterId": uuid}
		clusterRef[uuid] = contract.CiRef{Type: typeCluster, Identity: identity}
		clusterName[uuid] = cl.Status.Name
		aos := cl.Status.Resources.Config.Build.Version
		if nos, ok := cl.Status.Resources.Config.SoftwareMap["NOS"]; ok && nos.Version != "" {
			aos = nos.Version
		}
		hvVersion := ""
		if len(cl.Status.Resources.Nodes.HypervisorServerList) > 0 {
			hvVersion = cl.Status.Resources.Nodes.HypervisorServerList[0].Version
		}
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeCluster, Identity: identity, Name: cl.Status.Name,
			Attributes: map[string]any{"platform": platform, "prism": target.Value, "uuid": uuid, "aosVersion": aos, "hypervisorVersion": hvVersion, "externalIp": cl.Status.Resources.Network.ExternalIP, "nodeCount": len(cl.Status.Resources.Nodes.HypervisorServerList), "services": cl.Status.Resources.Config.ServiceList},
			Tags:       []string{}, ExternalIDs: []contract.ExternalID{{Source: platform, ID: uuid}}, ObservedAt: at})
	}
	hvRef := map[string]contract.CiRef{}
	for _, h := range inv.Hosts {
		r := h.Status.Resources
		serial := firstNonEmpty(r.SerialNumber, r.Block.BlockSerialNumber+"-"+h.Metadata.UUID)
		hostRef := firstNonEmpty(h.Status.Name, serial)
		hostIdentity := map[string]string{"serialNumber": serial}
		if h.Status.Name != "" {
			hostIdentity["fqdn"] = h.Status.Name
		}
		host := contract.CiRef{Type: typeHost, Identity: hostIdentity}
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeHost, Identity: hostIdentity, Name: h.Status.Name,
			Attributes: map[string]any{"model": r.Block.BlockModel, "blockSerial": r.Block.BlockSerialNumber, "cpuModel": r.CPUModel, "cpuSockets": r.NumCPUSockets, "cpuCores": r.NumCPUCores, "memoryMb": r.MemoryCapacityMib, "cvmIp": r.ControllerVM.IP, "hostType": r.HostType, "nutanixCluster": clusterName[h.Status.ClusterReference.UUID]},
			Tags:       []string{}, ExternalIDs: []contract.ExternalID{{Source: platform, ID: h.Metadata.UUID}}, ObservedAt: at})
		if r.IPMI.IP != "" {
			bmcIdentity := map[string]string{"managementIp": r.IPMI.IP}
			obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeBmc, Identity: bmcIdentity, Name: "IPMI @ " + r.IPMI.IP, Attributes: map[string]any{"managementIp": r.IPMI.IP, "host": h.Status.Name}, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
			obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relManages, From: contract.CiRef{Type: typeBmc, Identity: bmcIdentity}, To: host, Attributes: map[string]any{"protocol": "ipmi"}, ObservedAt: at})
		}
		hvIdentity := map[string]string{"platform": platform, "hostRef": hostRef, "moRef": h.Metadata.UUID}
		hv := contract.CiRef{Type: typeHypervisor, Identity: hvIdentity}
		hvRef[h.Metadata.UUID] = hv
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeHypervisor, Identity: hvIdentity, Name: h.Status.Name,
			Attributes: map[string]any{"platform": platform, "hypervisorIp": r.Hypervisor.IP, "hypervisorFullName": r.Hypervisor.HypervisorFullName, "uuid": h.Metadata.UUID, "nutanixCluster": clusterName[h.Status.ClusterReference.UUID]},
			Tags:       []string{}, ExternalIDs: []contract.ExternalID{{Source: platform, ID: h.Metadata.UUID}}, ObservedAt: at})
		obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relHostedOn, From: hv, To: host, Attributes: map[string]any{}, ObservedAt: at})
		if cl, ok := clusterRef[h.Status.ClusterReference.UUID]; ok {
			obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relMemberOf, From: hv, To: cl, Attributes: map[string]any{}, ObservedAt: at})
		}
	}
	subnetRef := map[string]contract.CiRef{}
	vlanRef := map[string]contract.CiRef{}
	for _, s := range inv.Subnets {
		r := s.Status.Resources
		cidr := ""
		if r.IPConfig.SubnetIP != "" {
			cidr = r.IPConfig.SubnetIP + "/" + strconv.Itoa(r.IPConfig.PrefixLength)
		}
		if cidr != "" {
			identity := map[string]string{"cidr": cidr, "vrfRef": defaultVrf}
			subnetRef[s.Metadata.UUID] = contract.CiRef{Type: typeSubnet, Identity: identity}
			obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeSubnet, Identity: identity, Name: s.Status.Name,
				Attributes: map[string]any{"cidr": cidr, "gateway": r.IPConfig.DefaultGatewayIP, "vlanId": r.VlanID, "subnetType": r.SubnetType, "nutanixCluster": clusterName[s.Status.ClusterReference.UUID], "source": platform},
				Tags:       []string{}, ExternalIDs: []contract.ExternalID{{Source: platform, ID: s.Metadata.UUID}}, ObservedAt: at})
		}
		if r.SubnetType == "VLAN" {
			deviceRef := firstNonEmpty(clusterName[s.Status.ClusterReference.UUID], target.Value)
			identity := map[string]string{"deviceRef": deviceRef, "vlanId": strconv.Itoa(r.VlanID)}
			vlanRef[s.Metadata.UUID] = contract.CiRef{Type: typeVlan, Identity: identity}
			obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeVlan, Identity: identity, Name: s.Status.Name, Attributes: map[string]any{"vlanId": r.VlanID, "scope": "ahv-virtual-switch", "nutanixCluster": deviceRef}, Tags: []string{}, ExternalIDs: []contract.ExternalID{{Source: platform, ID: s.Metadata.UUID}}, ObservedAt: at})
			if sn, ok := subnetRef[s.Metadata.UUID]; ok {
				obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relInVlan, From: sn, To: vlanRef[s.Metadata.UUID], Attributes: map[string]any{}, ObservedAt: at})
			}
		}
	}
	containerRef := map[string]contract.CiRef{}
	for _, c := range inv.Containers {
		identity := map[string]string{"arrayRef": c.ClusterUUID, "wwn": c.ClusterUUID + ":" + c.StorageContainerUUID}
		containerRef[c.StorageContainerUUID] = contract.CiRef{Type: typeLun, Identity: identity}
		used, _ := strconv.ParseInt(c.UsageStats["storage.usage_bytes"], 10, 64)
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeLun, Identity: identity, Name: c.Name,
			Attributes: map[string]any{"kind": "storage_container", "capacityBytes": c.MaxCapacity, "usedBytes": used, "replicationFactor": c.ReplicationFactor, "compression": c.CompressionEnabled, "nutanixCluster": clusterName[c.ClusterUUID], "source": platform},
			Tags:       []string{}, ExternalIDs: []contract.ExternalID{{Source: platform, ID: c.StorageContainerUUID}}, ObservedAt: at})
	}
	for _, vm := range inv.VMs {
		r := vm.Status.Resources
		hv, hasHv := hvRef[r.HostReference.UUID]
		identity := map[string]string{"instanceUuid": strings.ToLower(vm.Metadata.UUID), "hypervisorRef": hv.Identity["hostRef"]}
		macs := []string{}
		ips := []string{}
		for _, nic := range r.NicList {
			if nic.MacAddress != "" {
				macs = append(macs, strings.ToLower(nic.MacAddress))
			}
			for _, ep := range nic.IPEndpointList {
				if ep.IP != "" {
					ips = append(ips, ep.IP)
				}
			}
		}
		var diskBytes int64
		containers := map[string]bool{}
		for _, d := range r.DiskList {
			if d.DeviceProperties.DeviceType == "CDROM" {
				continue
			}
			diskBytes += d.DiskSizeBytes
			if d.StorageConfig.StorageContainerReference.UUID != "" {
				containers[d.StorageConfig.StorageContainerReference.UUID] = true
			}
		}
		guest := r.GuestTools.NutanixGuestTools.GuestOSVersion
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeVM, Identity: identity, Name: vm.Status.Name,
			Attributes: map[string]any{"platform": platform, "powerState": r.PowerState, "cpuCount": r.NumSockets * r.NumVcpusPerSocket, "memoryMb": r.MemorySizeMib, "macAddresses": macs, "ipAddresses": ips, "diskBytes": diskBytes, "diskCount": len(containers), "guestOs": guest, "nutanixCluster": clusterName[vm.Status.ClusterReference.UUID], "uuid": vm.Metadata.UUID},
			Tags:       []string{}, ExternalIDs: []contract.ExternalID{{Source: platform, ID: vm.Metadata.UUID}}, ObservedAt: at})
		vmRef := contract.CiRef{Type: typeVM, Identity: identity}
		if hasHv {
			obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relRunsOn, From: vmRef, To: hv, Attributes: map[string]any{}, ObservedAt: at})
		}
		for uuid := range containers {
			if cr, ok := containerRef[uuid]; ok {
				obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relMountedOn, From: vmRef, To: cr, Attributes: map[string]any{}, ObservedAt: at})
			}
		}
		if fam := osFamily(guest); fam != "" {
			osIdentity := map[string]string{"hostRef": identity["instanceUuid"], "family": fam, "version": guest}
			obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeOS, Identity: osIdentity, Name: guest, Attributes: map[string]any{"family": fam, "source": "nutanix-guest-tools"}, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
			obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relInstalledOn, From: contract.CiRef{Type: typeOS, Identity: osIdentity}, To: vmRef, Attributes: map[string]any{}, ObservedAt: at})
		}
		for _, nic := range r.NicList {
			for _, ep := range nic.IPEndpointList {
				if ep.IP == "" {
					continue
				}
				ipIdentity := map[string]string{"address": ep.IP, "vrfRef": defaultVrf}
				obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeIP, Identity: ipIdentity, Name: ep.IP, Attributes: map[string]any{"mac": strings.ToLower(nic.MacAddress), "assignedTo": vm.Status.Name, "subnet": nic.SubnetReference.Name}, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
				ipRef := contract.CiRef{Type: typeIP, Identity: ipIdentity}
				obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relUsesIP, From: vmRef, To: ipRef, Attributes: map[string]any{}, ObservedAt: at})
				if sn, ok := subnetRef[nic.SubnetReference.UUID]; ok {
					obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relInSubnet, From: ipRef, To: sn, Attributes: map[string]any{}, ObservedAt: at})
				}
			}
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
		return collector.Observation{}, collector.Errorf(contract.ErrAuthFailed, false, "nutanix requires a password credential with a username")
	}
	c, err := restjson.New(target.Value, defaultPort, restjson.Auth{User: cred.Fields[credUser], Pass: cred.Fields[credPassword]}, restjson.Options{VerifyTLS: restjson.BoolOption(options, optionVerify), CAPem: restjson.StringOption(options, optionCA)})
	if err != nil {
		return collector.Observation{}, err
	}
	inv, err := Walk(ctx, c)
	if err != nil {
		return collector.Observation{}, restjson.Classify(target.Value, err)
	}
	return Emit(inv, target, time.Now().UTC()), nil
}
