// REQ-DISC-002 — agentless Windows collector over WinRM: one PowerShell script gathers CIM/WMI
// inventory (system, BIOS, OS, CPUs, adapters, addresses, listeners, installed software, services,
// hotfixes, logical disks) as a single JSON document and the Go side emits host-or-vm, OS,
// interfaces, IPs, listening services, software and software instances.
package windows

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/collector"
	"github.com/openmap/openmap/apps/collectors/internal/contract"
	"github.com/openmap/openmap/apps/collectors/internal/winrmexec"
)

const (
	collectorID  = "wmi"
	version      = "0.1.0"
	evidenceKind = "api_response"
	defaultVrf   = "default"

	typeHost      = "host"
	typeVM        = "vm"
	typeOS        = "operating_system"
	typeInterface = "interface"
	typeIP        = "ip_address"
	typeListener  = "listening_service"
	typeSoftware  = "software"
	typeInstall   = "software_instance"

	relInstalledOn = "installed_on"
	relContains    = "contains"
	relUsesIP      = "uses_ip"
	relRunsOn      = "runs_on"
	relMemberOf    = "member_of"
)

type Collector struct{}

func (Collector) Manifest() contract.Manifest {
	return contract.Manifest{
		ID: collectorID, Family: "wmi", Version: version, Language: "go",
		Protocols: []string{"winrm"}, CredentialTypes: []string{"password"},
		TargetKinds: []string{"host"}, Emits: []string{typeHost, typeVM, typeOS, typeInterface, typeIP, typeListener, typeSoftware, typeInstall},
		ContractVersion: contract.Version,
	}
}

// Script is the PowerShell run on every target. Every section tolerates failure so one missing
// cmdlet (older builds, Server Core) never fails the host.
const Script = `
$ErrorActionPreference = 'SilentlyContinue'
function Sec($block) { try { & $block } catch { $null } }
$cs   = Sec { Get-CimInstance Win32_ComputerSystem | Select-Object Name,Domain,Manufacturer,Model,TotalPhysicalMemory,NumberOfProcessors,NumberOfLogicalProcessors,HypervisorPresent,DomainRole,PartOfDomain }
$bios = Sec { Get-CimInstance Win32_BIOS | Select-Object SerialNumber,SMBIOSBIOSVersion,Manufacturer,ReleaseDate }
$prod = Sec { Get-CimInstance Win32_ComputerSystemProduct | Select-Object UUID,IdentifyingNumber,Vendor,Name }
$os   = Sec { Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version,BuildNumber,OSArchitecture,InstallDate,LastBootUpTime,ServicePackMajorVersion,TotalVisibleMemorySize,FreePhysicalMemory }
$load = Sec { Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'" | Select-Object -ExpandProperty PercentProcessorTime }
$cpu  = Sec { Get-CimInstance Win32_Processor | Select-Object DeviceID,SocketDesignation,Name,Manufacturer,NumberOfCores,NumberOfLogicalProcessors,MaxClockSpeed }
$nics = Sec { Get-NetAdapter | Select-Object Name,InterfaceDescription,InterfaceIndex,MacAddress,LinkSpeed,Status,ifOperStatus,HardwareInterface,DriverVersion }
$ips  = Sec { Get-NetIPAddress -AddressFamily IPv4,IPv6 | Where-Object { $_.AddressState -ne 'Tentative' } | Select-Object InterfaceIndex,IPAddress,PrefixLength,AddressFamily,PrefixOrigin }
$tcp  = Sec { Get-NetTCPConnection -State Listen | Select-Object LocalAddress,LocalPort,OwningProcess }
$udp  = Sec { Get-NetUDPEndpoint | Select-Object LocalAddress,LocalPort,OwningProcess }
$proc = Sec { Get-Process | Select-Object Id,ProcessName,Path }
$sw   = Sec { Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*' | Where-Object { $_.DisplayName } | Select-Object DisplayName,DisplayVersion,Publisher,InstallDate,InstallLocation }
$svc  = Sec { Get-CimInstance Win32_Service | Select-Object Name,DisplayName,State,StartMode,PathName,StartName }
$hot  = Sec { Get-HotFix | Select-Object HotFixID,Description,InstalledOn }
$disk = Sec { Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Select-Object DeviceID,Size,FreeSpace,FileSystem,VolumeName }
$mem  = Sec { Get-CimInstance Win32_PhysicalMemory | Select-Object BankLabel,DeviceLocator,Capacity,Manufacturer,SerialNumber,PartNumber,ConfiguredClockSpeed }
$drv  = Sec { Get-CimInstance Win32_DiskDrive | Select-Object Index,Model,SerialNumber,Size,FirmwareRevision,InterfaceType,MediaType }
$hba  = Sec { Get-InitiatorPort | Where-Object { $_.ConnectionType -eq 'Fibre Channel' } | Select-Object InstanceName,PortAddress,NodeAddress,OperationalStatus }
$fqdn = Sec { [System.Net.Dns]::GetHostEntry($env:COMPUTERNAME).HostName }
$feat = Sec { Get-WindowsFeature | Where-Object Installed | Select-Object -ExpandProperty Name }
[pscustomobject]@{ computer=$cs; bios=$bios; product=$prod; os=$os; cpu=@($cpu); nics=@($nics); ips=@($ips); tcp=@($tcp); udp=@($udp); processes=@($proc); software=@($sw); services=@($svc); hotfixes=@($hot); disks=@($disk); memory=@($mem); drives=@($drv); hbas=@($hba); cpuLoad=$load; fqdn=$fqdn; features=@($feat) } | ConvertTo-Json -Depth 5 -Compress
`

// Inventory mirrors the JSON document the script prints. CIM date strings are kept raw.
type Inventory struct {
	Computer struct {
		Name                      string `json:"Name"`
		Domain                    string `json:"Domain"`
		Manufacturer              string `json:"Manufacturer"`
		Model                     string `json:"Model"`
		TotalPhysicalMemory       int64  `json:"TotalPhysicalMemory"`
		NumberOfProcessors        int    `json:"NumberOfProcessors"`
		NumberOfLogicalProcessors int    `json:"NumberOfLogicalProcessors"`
		HypervisorPresent         bool   `json:"HypervisorPresent"`
		DomainRole                int    `json:"DomainRole"`
		PartOfDomain              bool   `json:"PartOfDomain"`
	} `json:"computer"`
	Bios struct {
		SerialNumber      string `json:"SerialNumber"`
		SMBIOSBIOSVersion string `json:"SMBIOSBIOSVersion"`
		Manufacturer      string `json:"Manufacturer"`
	} `json:"bios"`
	Product struct {
		UUID              string `json:"UUID"`
		IdentifyingNumber string `json:"IdentifyingNumber"`
		Vendor            string `json:"Vendor"`
		Name              string `json:"Name"`
	} `json:"product"`
	OS struct {
		Caption        string `json:"Caption"`
		Version        string `json:"Version"`
		BuildNumber    string `json:"BuildNumber"`
		OSArchitecture string `json:"OSArchitecture"`
		InstallDate    any    `json:"InstallDate"`
		LastBootUpTime any    `json:"LastBootUpTime"`
		// Kilobytes (REQ-CMDB-034).
		TotalVisibleMemorySize int64 `json:"TotalVisibleMemorySize"`
		FreePhysicalMemory     int64 `json:"FreePhysicalMemory"`
	} `json:"os"`
	CPU []struct {
		DeviceID                  string `json:"DeviceID"`
		SocketDesignation         string `json:"SocketDesignation"`
		Manufacturer              string `json:"Manufacturer"`
		Name                      string `json:"Name"`
		NumberOfCores             int    `json:"NumberOfCores"`
		NumberOfLogicalProcessors int    `json:"NumberOfLogicalProcessors"`
	} `json:"cpu"`
	Nics []struct {
		Name                 string `json:"Name"`
		InterfaceDescription string `json:"InterfaceDescription"`
		InterfaceIndex       int    `json:"InterfaceIndex"`
		MacAddress           string `json:"MacAddress"`
		LinkSpeed            string `json:"LinkSpeed"`
		Status               string `json:"Status"`
		HardwareInterface    bool   `json:"HardwareInterface"`
		DriverVersion        string `json:"DriverVersion"`
	} `json:"nics"`
	IPs []struct {
		InterfaceIndex int    `json:"InterfaceIndex"`
		IPAddress      string `json:"IPAddress"`
		PrefixLength   int    `json:"PrefixLength"`
		AddressFamily  any    `json:"AddressFamily"`
		PrefixOrigin   any    `json:"PrefixOrigin"`
	} `json:"ips"`
	TCP []struct {
		LocalAddress  string `json:"LocalAddress"`
		LocalPort     int    `json:"LocalPort"`
		OwningProcess int    `json:"OwningProcess"`
	} `json:"tcp"`
	UDP []struct {
		LocalAddress  string `json:"LocalAddress"`
		LocalPort     int    `json:"LocalPort"`
		OwningProcess int    `json:"OwningProcess"`
	} `json:"udp"`
	Processes []struct {
		ID          int    `json:"Id"`
		ProcessName string `json:"ProcessName"`
		Path        string `json:"Path"`
	} `json:"processes"`
	Software []struct {
		DisplayName     string `json:"DisplayName"`
		DisplayVersion  string `json:"DisplayVersion"`
		Publisher       string `json:"Publisher"`
		InstallDate     string `json:"InstallDate"`
		InstallLocation string `json:"InstallLocation"`
	} `json:"software"`
	Services []struct {
		Name        string `json:"Name"`
		DisplayName string `json:"DisplayName"`
		State       string `json:"State"`
		StartMode   string `json:"StartMode"`
		PathName    string `json:"PathName"`
		StartName   string `json:"StartName"`
	} `json:"services"`
	Hotfixes []struct {
		HotFixID    string `json:"HotFixID"`
		Description string `json:"Description"`
		InstalledOn any    `json:"InstalledOn"`
	} `json:"hotfixes"`
	Disks []struct {
		DeviceID   string `json:"DeviceID"`
		Size       int64  `json:"Size"`
		FreeSpace  int64  `json:"FreeSpace"`
		FileSystem string `json:"FileSystem"`
		VolumeName string `json:"VolumeName"`
	} `json:"disks"`
	Memory []struct {
		BankLabel            string `json:"BankLabel"`
		DeviceLocator        string `json:"DeviceLocator"`
		Capacity             int64  `json:"Capacity"`
		Manufacturer         string `json:"Manufacturer"`
		SerialNumber         string `json:"SerialNumber"`
		PartNumber           string `json:"PartNumber"`
		ConfiguredClockSpeed int    `json:"ConfiguredClockSpeed"`
	} `json:"memory"`
	Drives []struct {
		Index            int    `json:"Index"`
		Model            string `json:"Model"`
		SerialNumber     string `json:"SerialNumber"`
		Size             int64  `json:"Size"`
		FirmwareRevision string `json:"FirmwareRevision"`
		InterfaceType    string `json:"InterfaceType"`
		MediaType        string `json:"MediaType"`
	} `json:"drives"`
	HBAs []struct {
		InstanceName      string `json:"InstanceName"`
		PortAddress       string `json:"PortAddress"`
		NodeAddress       string `json:"NodeAddress"`
		OperationalStatus any    `json:"OperationalStatus"`
	} `json:"hbas"`
	// CPULoad is the _Total processor time share; nil when the counter was unreadable (REQ-CMDB-034).
	CPULoad  *float64 `json:"cpuLoad"`
	FQDN     string   `json:"fqdn"`
	Features []string `json:"features"`
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

var virtualModels = []string{"virtual machine", "vmware", "virtualbox", "kvm", "hvm domu", "openstack", "google compute", "amazon ec2", "nutanix", "ahv", "parallels", "qemu", "xen"}

// isVirtual decides host vs vm from the hypervisor flag and well-known virtual model names.
func isVirtual(inv *Inventory) (bool, string) {
	model := strings.ToLower(inv.Computer.Manufacturer + " " + inv.Computer.Model)
	for _, m := range virtualModels {
		if strings.Contains(model, m) {
			return true, strings.TrimSpace(inv.Computer.Manufacturer)
		}
	}
	if inv.Computer.HypervisorPresent && strings.Contains(model, "hyper-v") {
		return true, "Microsoft Hyper-V"
	}
	return false, ""
}

func normMac(mac string) string {
	return strings.ToLower(strings.ReplaceAll(mac, "-", ":"))
}

// Emit converts the inventory into contract observations.
func Emit(inv *Inventory, target contract.Target, raw []byte, at time.Time) collector.Observation {
	obs := collector.Observation{Evidence: []collector.RawEvidence{{Kind: evidenceKind, Data: raw}}}
	fqdn := strings.ToLower(firstNonEmpty(inv.FQDN, joinDomain(inv.Computer.Name, inv.Computer.Domain), inv.Computer.Name, target.Value))
	serial := strings.TrimSpace(inv.Bios.SerialNumber)
	uuid := strings.ToLower(strings.TrimSpace(inv.Product.UUID))
	virtual, hypervisorVendor := isVirtual(inv)
	hostType := typeHost
	identity := map[string]string{}
	if virtual {
		hostType = typeVM
		if uuid != "" {
			identity["instanceUuid"] = uuid
		}
		identity["hypervisorRef"] = firstNonEmpty(hypervisorVendor, "unknown")
		identity["fqdn"] = fqdn
	} else {
		if serial != "" && !strings.EqualFold(serial, "To be filled by O.E.M.") {
			identity["serialNumber"] = serial
		}
		if uuid != "" {
			identity["systemUuid"] = uuid
		}
		identity["fqdn"] = fqdn
	}
	hostRef := firstNonEmpty(serial, uuid, fqdn)
	if virtual {
		hostRef = firstNonEmpty(uuid, fqdn)
	}
	var primaryMac string
	macs := []string{}
	for _, n := range inv.Nics {
		if m := normMac(n.MacAddress); m != "" && strings.EqualFold(n.Status, "Up") {
			macs = append(macs, m)
		}
	}
	if len(macs) > 0 {
		primaryMac = macs[0]
		if !virtual {
			identity["primaryMac"] = primaryMac
		}
	}
	cores, logical := 0, 0
	cpuModel := ""
	for _, c := range inv.CPU {
		cores += c.NumberOfCores
		logical += c.NumberOfLogicalProcessors
		cpuModel = c.Name
	}
	var diskBytes int64
	disks := []map[string]any{}
	for _, d := range inv.Disks {
		diskBytes += d.Size
		disks = append(disks, map[string]any{"device": d.DeviceID, "sizeBytes": d.Size, "freeBytes": d.FreeSpace, "fileSystem": d.FileSystem, "label": d.VolumeName})
	}
	hotfixes := []string{}
	for _, h := range inv.Hotfixes {
		hotfixes = append(hotfixes, h.HotFixID)
	}
	attrs := map[string]any{
		"hostname": inv.Computer.Name, "fqdn": fqdn, "domain": inv.Computer.Domain, "partOfDomain": inv.Computer.PartOfDomain, "domainRole": inv.Computer.DomainRole,
		"manufacturer": inv.Computer.Manufacturer, "model": inv.Computer.Model, "biosVersion": inv.Bios.SMBIOSBIOSVersion, "serialNumber": serial, "systemUuid": uuid,
		"cpuModel": cpuModel, "cpuSockets": inv.Computer.NumberOfProcessors, "cpuCores": cores, "cpuCount": logical, "memoryMb": inv.Computer.TotalPhysicalMemory / (1 << 20),
		"diskBytes": diskBytes, "disks": disks, "macAddresses": macs, "managementIp": target.Value, "hotfixes": hotfixes, "windowsFeatures": inv.Features, "virtual": virtual,
	}
	hostCi := contract.ObservedCi{Type: hostType, Identity: identity, Name: fqdn, Attributes: attrs, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at, Components: Components(inv)}
	obs.Cis = append(obs.Cis, hostCi)
	hostRefCi := contract.CiRef{Type: hostType, Identity: identity}
	obs.Samples = Samples(inv, hostRefCi, at)

	if inv.OS.Caption != "" {
		osIdentity := map[string]string{"hostRef": hostRef, "family": "windows", "version": firstNonEmpty(inv.OS.Version, inv.OS.BuildNumber)}
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeOS, Identity: osIdentity, Name: inv.OS.Caption,
			Attributes: map[string]any{"family": "windows", "caption": inv.OS.Caption, "version": inv.OS.Version, "build": inv.OS.BuildNumber, "architecture": inv.OS.OSArchitecture, "installDate": inv.OS.InstallDate, "lastBoot": inv.OS.LastBootUpTime, "hotfixCount": len(inv.Hotfixes), "source": "wmi"},
			Tags:       []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
		obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relInstalledOn, From: contract.CiRef{Type: typeOS, Identity: osIdentity}, To: hostRefCi, Attributes: map[string]any{}, ObservedAt: at})
	}

	ifByIndex := map[int]contract.CiRef{}
	for _, n := range inv.Nics {
		ifIdentity := map[string]string{"deviceRef": hostRef, "ifIndex": strconv.Itoa(n.InterfaceIndex), "name": n.Name}
		ref := contract.CiRef{Type: typeInterface, Identity: ifIdentity}
		ifByIndex[n.InterfaceIndex] = ref
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeInterface, Identity: ifIdentity, Name: n.Name, Attributes: map[string]any{"description": n.InterfaceDescription, "mac": normMac(n.MacAddress), "linkSpeed": n.LinkSpeed, "status": n.Status}, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
		obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relContains, From: hostRefCi, To: ref, Attributes: map[string]any{}, ObservedAt: at})
	}
	for _, ip := range inv.IPs {
		addr := ip.IPAddress
		if addr == "" || strings.HasPrefix(addr, "127.") || strings.HasPrefix(addr, "::1") || strings.HasPrefix(strings.ToLower(addr), "fe80:") || strings.HasPrefix(addr, "169.254.") {
			continue
		}
		ipIdentity := map[string]string{"address": addr, "vrfRef": defaultVrf}
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeIP, Identity: ipIdentity, Name: addr, Attributes: map[string]any{"cidr": addr + "/" + strconv.Itoa(ip.PrefixLength), "prefixLength": ip.PrefixLength, "assignedTo": fqdn, "ifIndex": ip.InterfaceIndex}, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
		from := hostRefCi
		if ref, ok := ifByIndex[ip.InterfaceIndex]; ok {
			from = ref
		}
		obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relUsesIP, From: from, To: contract.CiRef{Type: typeIP, Identity: ipIdentity}, Attributes: map[string]any{}, ObservedAt: at})
	}

	procName := map[int]string{}
	procPath := map[int]string{}
	for _, p := range inv.Processes {
		procName[p.ID] = p.ProcessName
		procPath[p.ID] = p.Path
	}
	seenListener := map[string]bool{}
	addListener := func(proto, addr string, port, pid int) {
		key := proto + ":" + strconv.Itoa(port)
		if seenListener[key] || port == 0 {
			return
		}
		seenListener[key] = true
		lsIdentity := map[string]string{"hostRef": hostRef, "protocol": proto, "port": strconv.Itoa(port)}
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeListener, Identity: lsIdentity, Name: proto + "/" + strconv.Itoa(port) + " " + procName[pid],
			Attributes: map[string]any{"protocol": proto, "port": port, "bindAddress": addr, "process": procName[pid], "processPath": procPath[pid], "pid": pid},
			Tags:       []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
		obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relRunsOn, From: contract.CiRef{Type: typeListener, Identity: lsIdentity}, To: hostRefCi, Attributes: map[string]any{}, ObservedAt: at})
	}
	for _, t := range inv.TCP {
		addListener("tcp", t.LocalAddress, t.LocalPort, t.OwningProcess)
	}
	for _, u := range inv.UDP {
		addListener("udp", u.LocalAddress, u.LocalPort, u.OwningProcess)
	}

	seenSoftware := map[string]bool{}
	for _, s := range inv.Software {
		name := strings.TrimSpace(s.DisplayName)
		ver := strings.TrimSpace(s.DisplayVersion)
		if name == "" || seenSoftware[name+"@"+ver] {
			continue
		}
		seenSoftware[name+"@"+ver] = true
		vendor := firstNonEmpty(strings.TrimSpace(s.Publisher), "unknown")
		swIdentity := map[string]string{"vendor": vendor, "name": name, "version": ver}
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeSoftware, Identity: swIdentity, Name: strings.TrimSpace(name + " " + ver), Attributes: map[string]any{"vendor": vendor, "packageManager": "windows-installer"}, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
		instIdentity := map[string]string{"hostRef": hostRef, "softwareRef": name + "@" + ver, "installPath": firstNonEmpty(s.InstallLocation, "windows-installer")}
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeInstall, Identity: instIdentity, Name: name + " on " + fqdn, Attributes: map[string]any{"installDate": s.InstallDate, "installLocation": s.InstallLocation}, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
		// One shape for software on every collector (SSH, WMI, agent): the instance is installed_on the host and is a
		// member_of the catalogue software, which is how vulnerability and licence queries reach the hosts.
		obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relInstalledOn, From: contract.CiRef{Type: typeInstall, Identity: instIdentity}, To: hostRefCi, Attributes: map[string]any{}, ObservedAt: at})
		obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relMemberOf, From: contract.CiRef{Type: typeInstall, Identity: instIdentity}, To: contract.CiRef{Type: typeSoftware, Identity: swIdentity}, Attributes: map[string]any{}, ObservedAt: at})
	}
	services := []map[string]any{}
	for _, s := range inv.Services {
		if strings.EqualFold(s.State, "Running") {
			services = append(services, map[string]any{"name": s.Name, "displayName": s.DisplayName, "startMode": s.StartMode, "account": s.StartName})
		}
	}
	obs.Cis[0].Attributes["runningServices"] = services
	return obs
}

func joinDomain(name, domain string) string {
	if name == "" {
		return ""
	}
	if domain == "" || strings.EqualFold(domain, "WORKGROUP") {
		return name
	}
	return name + "." + domain
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
	return Emit(inv, target, []byte(out.Stdout), time.Now().UTC()), nil
}
