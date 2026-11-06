// REQ-CMDB-014 (ADR-037) — parts inside a Windows host from the inventory document: processors per socket
// (Win32_Processor), memory modules (Win32_PhysicalMemory), physical disks (Win32_DiskDrive), hardware network
// adapters (Get-NetAdapter, HardwareInterface) and Fibre Channel initiator ports (Get-InitiatorPort).
package windows

import (
	"strconv"
	"strings"

	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

func clean(v string) string {
	v = strings.TrimSpace(v)
	switch strings.ToLower(v) {
	case "", "to be filled by o.e.m.", "unknown", "not specified", "none":
		return ""
	}
	return v
}

// Components lists the parts an inventory document shows.
func Components(inv *Inventory) []contract.Component {
	out := []contract.Component{}
	for i, c := range inv.CPU {
		slot := firstNonEmpty(clean(c.SocketDesignation), clean(c.DeviceID), strconv.Itoa(i))
		details := map[string]any{"cores": c.NumberOfCores, "threads": c.NumberOfLogicalProcessors}
		out = append(out, contract.Component{Kind: contract.ComponentCPU, Slot: slot, Model: clean(c.Name), Manufacturer: clean(c.Manufacturer), Details: details})
	}
	for i, m := range inv.Memory {
		slot := strings.TrimSpace(clean(m.BankLabel) + " " + clean(m.DeviceLocator))
		if slot == "" {
			slot = strconv.Itoa(i)
		}
		c := contract.Component{Kind: contract.ComponentMemory, Slot: slot, Manufacturer: clean(m.Manufacturer), SerialNumber: clean(m.SerialNumber), PartNumber: clean(m.PartNumber), CapacityBytes: float64(m.Capacity)}
		if m.ConfiguredClockSpeed > 0 {
			c.Details = map[string]any{"speedMts": m.ConfiguredClockSpeed}
		}
		out = append(out, c)
	}
	for _, d := range inv.Drives {
		c := contract.Component{Kind: contract.ComponentDisk, Slot: "PhysicalDrive" + strconv.Itoa(d.Index), Model: clean(d.Model), SerialNumber: clean(d.SerialNumber), CapacityBytes: float64(d.Size), Firmware: clean(d.FirmwareRevision)}
		details := map[string]any{}
		if t := clean(d.InterfaceType); t != "" {
			details["transport"] = t
		}
		if t := clean(d.MediaType); t != "" {
			details["media"] = t
		}
		if len(details) > 0 {
			c.Details = details
		}
		out = append(out, c)
	}
	for _, n := range inv.Nics {
		if !n.HardwareInterface {
			continue
		}
		details := map[string]any{}
		if m := normMac(n.MacAddress); m != "" {
			details["mac"] = m
		}
		if s := clean(n.LinkSpeed); s != "" {
			details["speed"] = s
		}
		out = append(out, contract.Component{Kind: contract.ComponentNIC, Slot: n.Name, Model: clean(n.InterfaceDescription), Firmware: clean(n.DriverVersion), Details: details})
	}
	for _, h := range inv.HBAs {
		if clean(h.PortAddress) == "" {
			continue
		}
		details := map[string]any{"wwpn": strings.ToLower(h.PortAddress)}
		if w := clean(h.NodeAddress); w != "" {
			details["wwnn"] = strings.ToLower(w)
		}
		out = append(out, contract.Component{Kind: contract.ComponentHBA, Slot: firstNonEmpty(clean(h.InstanceName), h.PortAddress), Details: details})
	}
	return out
}
