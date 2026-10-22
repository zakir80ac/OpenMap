// REQ-DISC-006 — Hyper-V collector over WinRM: one PowerShell script on a Hyper-V host (or any
// cluster node) gathers the host, failover cluster, virtual switches and every VM with adapters,
// disks and guest KVP data (OS, FQDN, addresses) as JSON; the Go side emits vm_cluster, hypervisor,
// host, vm, operating_system and ip_address with their relationships.
package hyperv

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/collector"
	"github.com/openmap/openmap/apps/collectors/internal/contract"
	"github.com/openmap/openmap/apps/collectors/internal/winrmexec"
)

const (
	collectorID  = "hyperv"
	version      = "0.1.0"
	platform     = "hyperv"
	evidenceKind = "api_response"
	defaultVrf   = "default"

	typeCluster    = "vm_cluster"
	typeHypervisor = "hypervisor"
	typeHost       = "host"
	typeVM         = "vm"
	typeOS         = "operating_system"
	typeIP         = "ip_address"
	relMemberOf    = "member_of"
	relHostedOn    = "hosted_on"
	relRunsOn      = "runs_on"
	relInstalledOn = "installed_on"
	relUsesIP      = "uses_ip"

	stateRunning = 2
	stateOff     = 3
	statePaused  = 9
)

type Collector struct{}

func (Collector) Manifest() contract.Manifest {
	return contract.Manifest{
		ID: collectorID, Family: "hyperv", Version: version, Language: "go",
		Protocols: []string{"winrm"}, CredentialTypes: []string{"password"},
		TargetKinds: []string{"host"}, Emits: []string{typeCluster, typeHypervisor, typeHost, typeVM, typeOS, typeIP},
		ContractVersion: contract.Version,
	}
}

// Script runs on the Hyper-V host. KVP intrinsic items carry the guest's OS name, FQDN and
// addresses when Integration Services are up; they are optional.
const Script = `
$ErrorActionPreference = 'SilentlyContinue'
function Sec($block) { try { & $block } catch { $null } }
$vmhost = Sec { Get-VMHost | Select-Object Name,FullyQualifiedDomainName,LogicalProcessorCount,MemoryCapacity,VirtualMachinePath,VirtualHardDiskPath }
$bios   = Sec { Get-CimInstance Win32_BIOS | Select-Object SerialNumber }
$cs     = Sec { Get-CimInstance Win32_ComputerSystem | Select-Object Manufacturer,Model,Domain }
$prod   = Sec { Get-CimInstance Win32_ComputerSystemProduct | Select-Object UUID }
$os     = Sec { Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version,BuildNumber }
$cluster = Sec { Get-Cluster | Select-Object Name,Id,Domain }
$nodes  = Sec { Get-ClusterNode | Select-Object Name,State }
$switches = Sec { Get-VMSwitch | Select-Object Name,Id,SwitchType,NetAdapterInterfaceDescription }
$vms = @()
foreach ($vm in (Sec { Get-VM })) {
  $kvp = @{}
  $kvpObj = Sec { Get-CimInstance -Namespace root\virtualization\v2 -ClassName Msvm_ComputerSystem -Filter "Name='$($vm.Id)'" | Get-CimAssociatedInstance -ResultClassName Msvm_KvpExchangeComponent }
  if ($kvpObj) { foreach ($item in $kvpObj.GuestIntrinsicExchangeItems) { $x = [xml]$item; $n = ($x.INSTANCE.PROPERTY | Where-Object Name -eq 'Name').VALUE; $d = ($x.INSTANCE.PROPERTY | Where-Object Name -eq 'Data').VALUE; if ($n) { $kvp[$n] = $d } } }
  $nics = @(Sec { Get-VMNetworkAdapter -VM $vm | Select-Object Name,MacAddress,SwitchName,Status,IPAddresses,VlanSetting })
  $disks = @()
  foreach ($d in (Sec { Get-VMHardDiskDrive -VM $vm })) { $vhd = Sec { Get-VHD -Path $d.Path }; $disks += [pscustomobject]@{ Path=$d.Path; ControllerType=[string]$d.ControllerType; Size=$vhd.Size; FileSize=$vhd.FileSize; VhdFormat=[string]$vhd.VhdFormat; VhdType=[string]$vhd.VhdType } }
  $vms += [pscustomobject]@{ Name=$vm.Name; Id=[string]$vm.Id; State=[int]$vm.State; ProcessorCount=$vm.ProcessorCount; MemoryAssigned=$vm.MemoryAssigned; MemoryStartup=$vm.MemoryStartup; DynamicMemoryEnabled=$vm.DynamicMemoryEnabled; Generation=$vm.Generation; Version=$vm.Version; ComputerName=$vm.ComputerName; IsClustered=$vm.IsClustered; Notes=$vm.Notes; Uptime=[string]$vm.Uptime; IntegrationServicesState=[string]$vm.IntegrationServicesState; Kvp=$kvp; Nics=$nics; Disks=$disks }
}
[pscustomobject]@{ host=$vmhost; bios=$bios; computer=$cs; product=$prod; os=$os; cluster=$cluster; nodes=@($nodes); switches=@($switches); vms=@($vms) } | ConvertTo-Json -Depth 6 -Compress
`

// Inventory mirrors the script's JSON document.
type Inventory struct {
	Host struct {
		Name                     string `json:"Name"`
		FullyQualifiedDomainName string `json:"FullyQualifiedDomainName"`
		LogicalProcessorCount    int    `json:"LogicalProcessorCount"`
		MemoryCapacity           int64  `json:"MemoryCapacity"`
		VirtualMachinePath       string `json:"VirtualMachinePath"`
	} `json:"host"`
	Bios struct {
		SerialNumber string `json:"SerialNumber"`
	} `json:"bios"`
	Computer struct {
		Manufacturer string `json:"Manufacturer"`
		Model        string `json:"Model"`
		Domain       string `json:"Domain"`
	} `json:"computer"`
	Product struct {
		UUID string `json:"UUID"`
	} `json:"product"`
	OS struct {
		Caption     string `json:"Caption"`
		Version     string `json:"Version"`
		BuildNumber string `json:"BuildNumber"`
	} `json:"os"`
	Cluster *struct {
		Name   string `json:"Name"`
		ID     string `json:"Id"`
		Domain string `json:"Domain"`
	} `json:"cluster"`
	Nodes []struct {
		Name  string `json:"Name"`
		State any    `json:"State"`
	} `json:"nodes"`
	Switches []struct {
		Name                           string `json:"Name"`
		ID                             string `json:"Id"`
		SwitchType                     any    `json:"SwitchType"`
		NetAdapterInterfaceDescription string `json:"NetAdapterInterfaceDescription"`
	} `json:"switches"`
	VMs []VM `json:"vms"`
}

type VM struct {
	Name                     string            `json:"Name"`
	ID                       string            `json:"Id"`
	State                    int               `json:"State"`
	ProcessorCount           int               `json:"ProcessorCount"`
	MemoryAssigned           int64             `json:"MemoryAssigned"`
	MemoryStartup            int64             `json:"MemoryStartup"`
	DynamicMemoryEnabled     bool              `json:"DynamicMemoryEnabled"`
	Generation               int               `json:"Generation"`
	Version                  string            `json:"Version"`
	ComputerName             string            `json:"ComputerName"`
	IsClustered              bool              `json:"IsClustered"`
	Notes                    string            `json:"Notes"`
	Uptime                   string            `json:"Uptime"`
	IntegrationServicesState string            `json:"IntegrationServicesState"`
	Kvp                      map[string]string `json:"Kvp"`
	Nics                     []struct {
		Name        string   `json:"Name"`
		MacAddress  string   `json:"MacAddress"`
		SwitchName  string   `json:"SwitchName"`
		Status      any      `json:"Status"`
		IPAddresses []string `json:"IPAddresses"`
	} `json:"Nics"`
	Disks []struct {
		Path           string `json:"Path"`
		ControllerType string `json:"ControllerType"`
		Size           int64  `json:"Size"`
		FileSize       int64  `json:"FileSize"`
		VhdFormat      string `json:"VhdFormat"`
		VhdType        string `json:"VhdType"`
	} `json:"Disks"`
}

// Parse decodes the script's JSON document.
func Parse(stdout string) (*Inventory, error) {
	start := strings.Index(stdout, "{")
	if start < 0 {
		return nil, collector.Errorf(contract.ErrParse, false, "collector script printed no JSON document")
	}
	var inv Inventory
	if err := json.Unmarshal([]byte(stdout[start:]), &inv); err != nil {
		return nil, collector.Errorf(contract.ErrParse, false, "collector script JSON: %v", err)
	}
	return &inv, nil
}

func powerState(s int) string {
	switch s {
	case stateRunning:
		return "running"
	case stateOff:
		return "stopped"
	case statePaused:
		return "paused"
	default:
		return "other"
	}
}

func normMac(mac string) string {
	m := strings.ToLower(strings.ReplaceAll(mac, "-", ""))
	m = strings.ReplaceAll(m, ":", "")
	if len(m) != 12 {
		return strings.ToLower(mac)
	}
	parts := make([]string, 0, 6)
	for i := 0; i < 12; i += 2 {
		parts = append(parts, m[i:i+2])
	}
	return strings.Join(parts, ":")
}

func osFamily(name string) string {
	n := strings.ToLower(name)
	switch {
	case strings.Contains(n, "windows"):
		return "windows"
	case n == "":
		return ""
	default:
		return "linux"
	}
}

// Emit converts the inventory into contract observations.
func Emit(inv *Inventory, target contract.Target, raw []byte, at time.Time) collector.Observation {
	obs := collector.Observation{Evidence: []collector.RawEvidence{{Kind: evidenceKind, Data: raw}}}
	hostFqdn := strings.ToLower(firstNonEmpty(inv.Host.FullyQualifiedDomainName, inv.Host.Name, target.Value))
	serial := strings.TrimSpace(inv.Bios.SerialNumber)
	uuid := strings.ToLower(strings.TrimSpace(inv.Product.UUID))
	hostIdentity := map[string]string{"fqdn": hostFqdn}
	if serial != "" {
		hostIdentity["serialNumber"] = serial
	}
	if uuid != "" {
		hostIdentity["systemUuid"] = uuid
	}
	host := contract.CiRef{Type: typeHost, Identity: hostIdentity}
	switches := []map[string]any{}
	for _, s := range inv.Switches {
		switches = append(switches, map[string]any{"name": s.Name, "type": s.SwitchType, "uplink": s.NetAdapterInterfaceDescription})
	}
	obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeHost, Identity: hostIdentity, Name: hostFqdn,
		Attributes: map[string]any{"manufacturer": inv.Computer.Manufacturer, "model": inv.Computer.Model, "serialNumber": serial, "cpuCount": inv.Host.LogicalProcessorCount, "memoryMb": inv.Host.MemoryCapacity / (1 << 20), "domain": inv.Computer.Domain, "managementIp": target.Value, "role": "hyper-v-host"},
		Tags:       []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
	hvIdentity := map[string]string{"platform": platform, "hostRef": hostFqdn, "moRef": firstNonEmpty(uuid, hostFqdn)}
	hv := contract.CiRef{Type: typeHypervisor, Identity: hvIdentity}
	obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeHypervisor, Identity: hvIdentity, Name: hostFqdn,
		Attributes: map[string]any{"platform": platform, "hypervisorOs": inv.OS.Caption, "hypervisorVersion": inv.OS.Version, "vmCount": len(inv.VMs), "virtualSwitches": switches, "vmPath": inv.Host.VirtualMachinePath, "managementIp": target.Value},
		Tags:       []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
	obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relHostedOn, From: hv, To: host, Attributes: map[string]any{}, ObservedAt: at})
	if inv.OS.Caption != "" {
		osIdentity := map[string]string{"hostRef": firstNonEmpty(serial, uuid, hostFqdn), "family": "windows", "version": firstNonEmpty(inv.OS.Version, inv.OS.BuildNumber)}
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeOS, Identity: osIdentity, Name: inv.OS.Caption, Attributes: map[string]any{"family": "windows", "caption": inv.OS.Caption, "build": inv.OS.BuildNumber, "source": "wmi"}, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
		obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relInstalledOn, From: contract.CiRef{Type: typeOS, Identity: osIdentity}, To: host, Attributes: map[string]any{}, ObservedAt: at})
	}
	if inv.Cluster != nil && inv.Cluster.Name != "" {
		clusterIdentity := map[string]string{"platform": platform, "clusterId": strings.ToLower(firstNonEmpty(inv.Cluster.ID, inv.Cluster.Name))}
		nodes := []string{}
		for _, n := range inv.Nodes {
			nodes = append(nodes, n.Name)
		}
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeCluster, Identity: clusterIdentity, Name: inv.Cluster.Name,
			Attributes: map[string]any{"platform": platform, "domain": inv.Cluster.Domain, "nodes": nodes, "nodeCount": len(nodes), "clusterId": inv.Cluster.ID},
			Tags:       []string{}, ExternalIDs: []contract.ExternalID{{Source: platform, ID: inv.Cluster.ID}}, ObservedAt: at})
		obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relMemberOf, From: hv, To: contract.CiRef{Type: typeCluster, Identity: clusterIdentity}, Attributes: map[string]any{}, ObservedAt: at})
	}
	for _, vm := range inv.VMs {
		id := strings.ToLower(vm.ID)
		identity := map[string]string{"instanceUuid": id, "hypervisorRef": hostFqdn}
		guestFqdn := strings.ToLower(vm.Kvp["FullyQualifiedDomainName"])
		if guestFqdn != "" {
			identity["fqdn"] = guestFqdn
		}
		macs := []string{}
		nets := []string{}
		addrs := []string{}
		for _, n := range vm.Nics {
			macs = append(macs, normMac(n.MacAddress))
			nets = append(nets, n.SwitchName)
			addrs = append(addrs, n.IPAddresses...)
		}
		var diskBytes, diskUsed int64
		paths := []string{}
		for _, d := range vm.Disks {
			diskBytes += d.Size
			diskUsed += d.FileSize
			paths = append(paths, d.Path)
		}
		vmRef := contract.CiRef{Type: typeVM, Identity: identity}
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeVM, Identity: identity, Name: vm.Name,
			Attributes: map[string]any{"platform": platform, "powerState": powerState(vm.State), "cpuCount": vm.ProcessorCount, "memoryMb": vm.MemoryAssigned / (1 << 20), "memoryStartupMb": vm.MemoryStartup / (1 << 20), "dynamicMemory": vm.DynamicMemoryEnabled, "generation": vm.Generation, "configVersion": vm.Version, "clustered": vm.IsClustered, "notes": vm.Notes, "uptime": vm.Uptime, "integrationServices": vm.IntegrationServicesState, "macAddresses": macs, "networks": nets, "ipAddresses": addrs, "diskBytes": diskBytes, "diskUsedBytes": diskUsed, "disks": paths, "diskCount": len(paths), "hypervisor": hostFqdn, "guestOs": vm.Kvp["OSName"], "guestOsVersion": vm.Kvp["OSVersion"]},
			Tags:       []string{}, ExternalIDs: []contract.ExternalID{{Source: platform, ID: vm.ID}}, ObservedAt: at})
		obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relRunsOn, From: vmRef, To: hv, Attributes: map[string]any{}, ObservedAt: at})
		if fam := osFamily(vm.Kvp["OSName"]); fam != "" {
			osIdentity := map[string]string{"hostRef": id, "family": fam, "version": firstNonEmpty(vm.Kvp["OSVersion"], vm.Kvp["OSName"])}
			obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeOS, Identity: osIdentity, Name: vm.Kvp["OSName"], Attributes: map[string]any{"family": fam, "version": vm.Kvp["OSVersion"], "source": "hyper-v-kvp"}, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
			obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relInstalledOn, From: contract.CiRef{Type: typeOS, Identity: osIdentity}, To: vmRef, Attributes: map[string]any{}, ObservedAt: at})
		}
		seen := map[string]bool{}
		for _, n := range vm.Nics {
			for _, a := range n.IPAddresses {
				if a == "" || seen[a] || strings.HasPrefix(strings.ToLower(a), "fe80:") || strings.HasPrefix(a, "169.254.") {
					continue
				}
				seen[a] = true
				ipIdentity := map[string]string{"address": a, "vrfRef": defaultVrf}
				obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeIP, Identity: ipIdentity, Name: a, Attributes: map[string]any{"mac": normMac(n.MacAddress), "switch": n.SwitchName, "assignedTo": vm.Name}, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
				obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relUsesIP, From: vmRef, To: contract.CiRef{Type: typeIP, Identity: ipIdentity}, Attributes: map[string]any{}, ObservedAt: at})
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
	out, err := winrmexec.Run(ctx, target, cred, options, Script)
	if err != nil {
		return collector.Observation{}, err
	}
	inv, err := Parse(out.Stdout)
	if err != nil {
		return collector.Observation{}, err
	}
	if inv.Host.Name == "" && len(inv.VMs) == 0 {
		return collector.Observation{}, collector.Errorf(contract.ErrUnsupportedDevice, false, "%s has no Hyper-V role (Get-VMHost returned nothing)", target.Value)
	}
	return Emit(inv, target, []byte(out.Stdout), time.Now().UTC()), nil
}
