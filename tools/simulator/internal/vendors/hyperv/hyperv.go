// REQ-QA-005 REQ-DISC-006 — simulated Hyper-V hosts behind WinRM for the hyperv collector. Every estate hypervisor
// on the hyperv platform answers the collector's script on its own loopback address with what Get-VMHost,
// Win32_BIOS/ComputerSystem/ComputerSystemProduct/OperatingSystem, Get-Cluster, Get-ClusterNode, Get-VMSwitch,
// Get-VM, the KVP exchange items, Get-VMNetworkAdapter, Get-VMHardDiskDrive and Get-VHD print through ConvertTo-Json.
//
// From the estate: the hypervisor and its host (FQDN, serial, UUID, vendor, model, cores, memory, OS build), the
// failover cluster and its nodes, and every VM hosted on the hypervisor (id, name, power state, vCPUs, memory, disk
// size, generation, guest OS, FQDN, address, MAC and network). Running VMs report guest data through KVP; a VM
// that is off reports none and no addresses, as on a real host. Seeded per object, because the estate does not
// carry them: cluster and switch GUIDs, VHD file usage and the uptime of running VMs.
package hyperv

import (
	"context"
	"strconv"
	"strings"

	"github.com/openmap/openmap/tools/simulator/internal/estate"
	"github.com/openmap/openmap/tools/simulator/internal/protocols/winrm"
	"github.com/openmap/openmap/tools/simulator/internal/sim"
	"github.com/openmap/openmap/tools/simulator/internal/vendors/windows"
)

const (
	platform       = "hyperv"
	signature      = "Get-VMHost"
	bytesPerGiB    = 1 << 30
	threadsPerCore = 2
	stateRunning   = 2
	stateOff       = 3
	nodeUp         = 0
	nicStatusOk    = 2
	switchExternal = 2
	usedMinPct     = 10
	usedMaxPct     = 90
	percent        = 100
	uptimeMaxDays  = 400
	hoursPerDay    = 24
	minutesPerHour = 60
	jobTimeoutMs   = 300000
	poweredOn      = "poweredOn"
	switchName     = "ConvergedSwitch"
)

type Vendor struct{}

func (Vendor) ID() string             { return "hyperv" }
func (Vendor) Collector() string      { return "hyperv" }
func (Vendor) Requirements() []string { return []string{"REQ-DISC-006"} }

// Node is one simulated Hyper-V host.
type Node struct {
	HV      *estate.CI
	Host    *estate.CI
	OS      *estate.CI
	Cluster *estate.CI
	Peers   []*estate.CI
	VMs     []*estate.CI
	e       *estate.Estate
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

// FQDN is the host's DNS name.
func (n *Node) FQDN() string {
	if n.Host != nil {
		return strings.ToLower(firstNonEmpty(n.Host.ID("fqdn"), n.Host.Str("fqdn")))
	}
	return strings.ToLower(firstNonEmpty(n.HV.ID("hostRef"), n.HV.Name))
}

// Nodes lists every estate Hyper-V hypervisor with its host, cluster and VMs.
func Nodes(e *estate.Estate) []*Node {
	var out []*Node
	for _, hv := range e.OfType("hypervisor", func(c *estate.CI) bool { return c.ID("platform") == platform }) {
		n := &Node{HV: hv, e: e}
		for _, h := range e.From(hv, "hosted_on") {
			if h.Type == "host" {
				n.Host = h
			}
		}
		if n.Host == nil {
			continue
		}
		for _, o := range e.To(n.Host, "installed_on") {
			if o.Type == "operating_system" {
				n.OS = o
			}
		}
		for _, c := range e.From(hv, "member_of") {
			if c.Type == "vm_cluster" {
				n.Cluster = c
				n.Peers = e.To(c, "member_of")
			}
		}
		for _, vm := range e.To(hv, "runs_on") {
			if vm.Type == "vm" {
				n.VMs = append(n.VMs, vm)
			}
		}
		out = append(out, n)
	}
	return out
}

// Caption is the host OS caption: the same Windows Server edition the wmi simulator reports for the host.
func (n *Node) Caption() string {
	return (&windows.Host{CI: n.Host, OS: n.os(), Software: n.e.To(n.Host, "installed_on")}).Caption()
}

func (n *Node) os() *estate.CI {
	if n.OS != nil {
		return n.OS
	}
	return &estate.CI{Attributes: map[string]any{"version": n.HV.Str("version")}}
}

// Build is the host OS version.
func (n *Node) Build() string { return firstNonEmpty(n.HV.Str("build"), "10.0.20348") }

// ClusterGUID is Get-Cluster's Id for the node's cluster.
func (n *Node) ClusterGUID() string {
	if n.Cluster == nil {
		return ""
	}
	// The estate carries Get-Cluster's Id as the cluster's clusterId; older estates keyed clusters by name.
	if id := n.Cluster.ID("clusterId"); sim.IsUUID(id) {
		return strings.ToLower(id)
	}
	return strings.ToLower(winrm.GUID("cluster", n.Cluster.ID("clusterId")))
}

func running(vm *estate.CI) bool { return vm.Str("powerState") == poweredOn }

// GuestVersion is the KVP OSVersion a guest reports.
func GuestVersion(vm *estate.CI, build string) string {
	if vm.Str("guestOsFamily") == "windows" {
		return build
	}
	f := strings.Fields(vm.Str("guestOs"))
	if len(f) == 0 {
		return ""
	}
	return f[len(f)-1]
}

func hexMac(mac string) string { return strings.ToUpper(strings.ReplaceAll(mac, ":", "")) }

func uptime(vm *estate.CI) string {
	if !running(vm) {
		return "00:00:00"
	}
	id := vm.ID("instanceUuid")
	return strconv.Itoa(winrm.Pick(1, uptimeMaxDays, id, "days")) + "." + two(winrm.Pick(0, hoursPerDay-1, id, "h")) + ":" + two(winrm.Pick(0, minutesPerHour-1, id, "m")) + ":" + two(winrm.Pick(0, minutesPerHour-1, id, "s"))
}

func two(n int) string {
	if n < 10 {
		return "0" + strconv.Itoa(n)
	}
	return strconv.Itoa(n)
}

// Inventory renders the document the collector's script prints on the node.
func (n *Node) Inventory() map[string]any {
	h := n.Host
	host := windows.Host{CI: h}
	hostname := firstNonEmpty(h.Str("hostname"), strings.SplitN(n.FQDN(), ".", 2)[0])
	cores := int(firstNum(n.HV.Num("cpuCores", 0), h.Num("cpuCores", 1)))
	memGiB := int64(firstNum(n.HV.Num("memoryGb", 0), h.Num("memoryGb", 0)))
	doc := map[string]any{
		"host": map[string]any{"Name": winrm.NetBIOS(hostname), "FullyQualifiedDomainName": n.FQDN(), "LogicalProcessorCount": cores * threadsPerCore, "MemoryCapacity": memGiB * bytesPerGiB,
			"VirtualMachinePath": `C:\ClusterStorage\Volume1\Hyper-V`, "VirtualHardDiskPath": `C:\ClusterStorage\Volume1\Hyper-V\Virtual Hard Disks`},
		"bios":     map[string]any{"SerialNumber": h.ID("serialNumber")},
		"computer": map[string]any{"Manufacturer": h.Str("manufacturer"), "Model": h.Str("model"), "Domain": host.Domain()},
		"product":  map[string]any{"UUID": strings.ToUpper(h.ID("systemUuid"))},
		"os":       map[string]any{"Caption": n.Caption(), "Version": n.Build(), "BuildNumber": n.Build()[strings.LastIndex(n.Build(), ".")+1:]},
		"cluster":  nil,
		"nodes":    []any{},
		"switches": []any{map[string]any{"Name": switchName, "Id": strings.ToLower(winrm.GUID("switch", n.FQDN())), "SwitchType": switchExternal, "NetAdapterInterfaceDescription": "Microsoft Network Adapter Multiplexor Driver"}},
	}
	if n.Cluster != nil {
		doc["cluster"] = map[string]any{"Name": n.Cluster.Name, "Id": n.ClusterGUID(), "Domain": host.Domain()}
		nodes := []any{}
		for _, p := range n.Peers {
			nodes = append(nodes, map[string]any{"Name": winrm.NetBIOS(p.Name), "State": nodeUp})
		}
		doc["nodes"] = nodes
	}
	vms := []any{}
	for _, vm := range n.VMs {
		id := vm.ID("instanceUuid")
		mem := int64(vm.Num("memoryGb", 0)) * bytesPerGiB
		state, assigned := stateOff, int64(0)
		kvp := map[string]string{}
		ips := []string{}
		if running(vm) {
			state, assigned = stateRunning, mem
			kvp = map[string]string{"OSName": vm.Str("guestOs"), "OSVersion": GuestVersion(vm, n.Build()), "FullyQualifiedDomainName": vm.ID("fqdn"), "NetworkAddressIPv4": vm.Str("ipAddress")}
			if ip := vm.Str("ipAddress"); ip != "" {
				ips = append(ips, ip)
			}
		}
		disk := int64(vm.Num("diskGb", 0)) * bytesPerGiB
		folder := `C:\ClusterStorage\` + firstNonEmpty(vm.Str("datastore"), "Volume1") + `\` + vm.Name
		vms = append(vms, map[string]any{
			"Name": vm.Name, "Id": id, "State": state, "ProcessorCount": int(vm.Num("vcpus", 1)), "MemoryAssigned": assigned, "MemoryStartup": mem, "DynamicMemoryEnabled": false,
			"Generation": 2, "Version": firstNonEmpty(vm.Str("hardwareVersion"), "10.0"), "ComputerName": winrm.NetBIOS(hostname), "IsClustered": n.Cluster != nil, "Notes": "",
			"Uptime": uptime(vm), "IntegrationServicesState": "Up to date", "Kvp": kvp,
			"Nics": []any{map[string]any{"Name": "Network Adapter", "MacAddress": hexMac(vm.Str("macAddress")), "SwitchName": switchName, "Status": []int{nicStatusOk}, "IPAddresses": ips,
				"VlanSetting": map[string]any{"OperationMode": 1, "AccessVlanId": 0}}},
			"Disks": []any{map[string]any{"Path": folder + `\` + vm.Name + ".vhdx", "ControllerType": "SCSI", "Size": disk, "FileSize": disk * int64(winrm.Pick(usedMinPct, usedMaxPct, id, "vhd")) / percent, "VhdFormat": "VHDX", "VhdType": "Dynamic"}},
		})
	}
	doc["vms"] = vms
	return doc
}

func firstNum(values ...float64) float64 {
	for _, v := range values {
		if v > 0 {
			return v
		}
	}
	return 0
}

// Script answers the collector's Hyper-V script on the node.
func (n *Node) Script(script string) winrm.Output {
	if !strings.Contains(script, signature) {
		return winrm.Unsupported(winrm.FirstCmdlet(script))
	}
	return winrm.Output{Stdout: winrm.JSON(n.Inventory())}
}

func (Vendor) Start(_ context.Context, e *estate.Estate, env *sim.Env) (*sim.Endpoint, error) {
	nodes := Nodes(e)
	keys := make([]string, len(nodes))
	byKey := map[string]*Node{}
	for i, n := range nodes {
		keys[i] = n.FQDN()
		byKey[keys[i]] = n
	}
	return winrm.Serve(env, keys, func(k string) winrm.Script { return byKey[k].Script })
}

func (Vendor) Runs(e *estate.Estate, ep *sim.Endpoint, env *sim.Env) []sim.Run {
	nodes := Nodes(e)
	keys := make([]string, len(nodes))
	byKey := map[string]*Node{}
	for i, n := range nodes {
		keys[i] = n.FQDN()
		byKey[keys[i]] = n
	}
	return windows.Plan("hyperv-hosts", ep, env, keys, nil, jobTimeoutMs, func(x *sim.Expect, fqdn string) {
		n := byKey[fqdn]
		x.CIs = append(x.CIs, sim.ExpectCI{Type: "host", Name: fqdn, Identity: n.Host.Identity})
		x.CIs = append(x.CIs, sim.ExpectCI{Type: "hypervisor", Name: fqdn, Identity: n.HV.Identity})
		x.Rel("hosted_on", "hypervisor", fqdn, "host", fqdn)
		osWant := sim.ExpectCI{Type: "operating_system", Name: n.Caption()}
		if n.OS != nil {
			osWant.Identity = n.OS.Identity
		}
		x.CIs = append(x.CIs, osWant)
		x.Rel("installed_on", "operating_system", n.Caption(), "host", fqdn)
		if n.Cluster != nil {
			// Every node reports its cluster, so each node's visit emits the vm_cluster CI.
			x.CIs = append(x.CIs, sim.ExpectCI{Type: "vm_cluster", Name: n.Cluster.Name, Identity: n.Cluster.Identity})
			x.Rel("member_of", "hypervisor", fqdn, "vm_cluster", n.Cluster.Name)
		}
		for _, vm := range n.VMs {
			x.CIs = append(x.CIs, sim.ExpectCI{Type: "vm", Name: vm.Name, Identity: vm.Identity})
			x.Rel("runs_on", "vm", vm.Name, "hypervisor", fqdn)
			if !running(vm) {
				continue
			}
			if g := vm.Str("guestOs"); g != "" {
				x.CI("operating_system", g)
				x.RelToRef("installed_on", "operating_system", g, "vm", map[string]string{"instanceUuid": vm.ID("instanceUuid")})
			}
			for _, ip := range e.From(vm, "uses_ip") {
				if ip.Type == "ip_address" {
					x.CIs = append(x.CIs, sim.ExpectCI{Type: "ip_address", Name: ip.ID("address"), Identity: ip.Identity})
					x.Rel("uses_ip", "vm", vm.Name, "ip_address", ip.ID("address"))
				}
			}
		}
	})
}
