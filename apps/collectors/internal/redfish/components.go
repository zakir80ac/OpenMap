// REQ-CMDB-014 (ADR-037) — parts a BMC reports over Redfish: Processors, Memory and the Drives of each Storage
// subsystem under a ComputerSystem, the chassis NetworkAdapters and the PowerSupplies of its Power resource.
package redfish

import (
	"context"
	"strings"

	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

const bytesPerMiB = 1 << 20

type processorDoc struct {
	ID           string `json:"Id"`
	Socket       string `json:"Socket"`
	Manufacturer string `json:"Manufacturer"`
	Model        string `json:"Model"`
	TotalCores   int    `json:"TotalCores"`
	TotalThreads int    `json:"TotalThreads"`
	MaxSpeedMHz  int    `json:"MaxSpeedMHz"`
	SerialNumber string `json:"SerialNumber"`
	PartNumber   string `json:"PartNumber"`
	Status       status `json:"Status"`
}

type memoryDoc struct {
	ID                string `json:"Id"`
	DeviceLocator     string `json:"DeviceLocator"`
	CapacityMiB       int64  `json:"CapacityMiB"`
	Manufacturer      string `json:"Manufacturer"`
	SerialNumber      string `json:"SerialNumber"`
	PartNumber        string `json:"PartNumber"`
	OperatingSpeedMhz int    `json:"OperatingSpeedMhz"`
	MemoryDeviceType  string `json:"MemoryDeviceType"`
	Status            status `json:"Status"`
}

type storageDoc struct {
	ID     string     `json:"Id"`
	Drives []odataRef `json:"Drives"`
}

type driveDoc struct {
	ID            string  `json:"Id"`
	Name          string  `json:"Name"`
	Model         string  `json:"Model"`
	Manufacturer  string  `json:"Manufacturer"`
	SerialNumber  string  `json:"SerialNumber"`
	PartNumber    string  `json:"PartNumber"`
	Revision      string  `json:"Revision"`
	CapacityBytes float64 `json:"CapacityBytes"`
	MediaType     string  `json:"MediaType"`
	Protocol      string  `json:"Protocol"`
	Status        status  `json:"Status"`
}

type adapterDoc struct {
	ID           string `json:"Id"`
	Manufacturer string `json:"Manufacturer"`
	Model        string `json:"Model"`
	SerialNumber string `json:"SerialNumber"`
	PartNumber   string `json:"PartNumber"`
	Controllers  []struct {
		FirmwarePackageVersion string `json:"FirmwarePackageVersion"`
	} `json:"Controllers"`
	Status status `json:"Status"`
}

// parts is what one system's part walk gathered.
type parts struct {
	Processors []processorDoc
	Memory     []memoryDoc
	Drives     []driveDoc
}

func (c *Client) eachMember(ctx context.Context, ref odataRef, inv *Inventory, visit func(odataRef)) {
	if ref.ID == "" {
		return
	}
	refs, raw, err := c.members(ctx, ref.ID)
	if err != nil {
		return
	}
	inv.Raw = append(inv.Raw, raw)
	for _, r := range refs {
		visit(r)
	}
}

// walkParts fetches the processors, memory and drives of a system; a missing collection is skipped, never fatal.
func (c *Client) walkParts(ctx context.Context, s systemDoc, inv *Inventory) parts {
	var p parts
	c.eachMember(ctx, s.Processors, inv, func(r odataRef) {
		var d processorDoc
		if raw, err := c.Get(ctx, r.ID, &d); err == nil {
			inv.Raw = append(inv.Raw, raw)
			p.Processors = append(p.Processors, d)
		}
	})
	c.eachMember(ctx, s.Memory, inv, func(r odataRef) {
		var d memoryDoc
		if raw, err := c.Get(ctx, r.ID, &d); err == nil {
			inv.Raw = append(inv.Raw, raw)
			p.Memory = append(p.Memory, d)
		}
	})
	c.eachMember(ctx, s.Storage, inv, func(r odataRef) {
		var st storageDoc
		raw, err := c.Get(ctx, r.ID, &st)
		if err != nil {
			return
		}
		inv.Raw = append(inv.Raw, raw)
		for _, dr := range st.Drives {
			var d driveDoc
			if raw, err := c.Get(ctx, dr.ID, &d); err == nil {
				inv.Raw = append(inv.Raw, raw)
				p.Drives = append(p.Drives, d)
			}
		}
	})
	return p
}

// walkAdapters fetches a chassis's network adapters.
func (c *Client) walkAdapters(ctx context.Context, ch chassisDoc, inv *Inventory) []adapterDoc {
	out := []adapterDoc{}
	c.eachMember(ctx, ch.NetworkAdapters, inv, func(r odataRef) {
		var d adapterDoc
		if raw, err := c.Get(ctx, r.ID, &d); err == nil {
			inv.Raw = append(inv.Raw, raw)
			out = append(out, d)
		}
	})
	return out
}

func absent(s status) bool {
	return strings.EqualFold(s.State, "Absent")
}

func processorParts(p parts) []contract.Component {
	out := []contract.Component{}
	for _, d := range p.Processors {
		if absent(d.Status) {
			continue
		}
		details := map[string]any{"cores": d.TotalCores, "threads": d.TotalThreads}
		if d.MaxSpeedMHz > 0 {
			details["maxSpeedMhz"] = d.MaxSpeedMHz
		}
		out = append(out, contract.Component{Kind: contract.ComponentCPU, Slot: firstNonEmpty(d.Socket, d.ID), Model: d.Model, Manufacturer: d.Manufacturer, SerialNumber: d.SerialNumber, PartNumber: d.PartNumber, Details: details})
	}
	return out
}

func memoryParts(p parts) []contract.Component {
	out := []contract.Component{}
	for _, d := range p.Memory {
		if absent(d.Status) || d.CapacityMiB == 0 {
			continue
		}
		details := map[string]any{}
		if d.MemoryDeviceType != "" {
			details["type"] = d.MemoryDeviceType
		}
		if d.OperatingSpeedMhz > 0 {
			details["speedMts"] = d.OperatingSpeedMhz
		}
		c := contract.Component{Kind: contract.ComponentMemory, Slot: firstNonEmpty(d.DeviceLocator, d.ID), Manufacturer: d.Manufacturer, SerialNumber: d.SerialNumber, PartNumber: strings.TrimSpace(d.PartNumber), CapacityBytes: float64(d.CapacityMiB * bytesPerMiB)}
		if len(details) > 0 {
			c.Details = details
		}
		out = append(out, c)
	}
	return out
}

func driveParts(p parts) []contract.Component {
	out := []contract.Component{}
	for _, d := range p.Drives {
		if absent(d.Status) {
			continue
		}
		details := map[string]any{}
		if d.MediaType != "" {
			details["media"] = strings.ToLower(d.MediaType)
		}
		if d.Protocol != "" {
			details["transport"] = d.Protocol
		}
		c := contract.Component{Kind: contract.ComponentDisk, Slot: firstNonEmpty(d.Name, d.ID), Model: d.Model, Manufacturer: d.Manufacturer, SerialNumber: d.SerialNumber, PartNumber: d.PartNumber, CapacityBytes: d.CapacityBytes, Firmware: d.Revision}
		if len(details) > 0 {
			c.Details = details
		}
		out = append(out, c)
	}
	return out
}

func chassisParts(inv *Inventory, chassisID string) []contract.Component {
	out := []contract.Component{}
	for _, a := range inv.Adapters[chassisID] {
		if absent(a.Status) {
			continue
		}
		c := contract.Component{Kind: contract.ComponentNIC, Slot: a.ID, Model: a.Model, Manufacturer: a.Manufacturer, SerialNumber: a.SerialNumber, PartNumber: a.PartNumber}
		if len(a.Controllers) > 0 {
			c.Firmware = a.Controllers[0].FirmwarePackageVersion
		}
		out = append(out, c)
	}
	supplies := inv.Power[chassisID].PowerSupplies
	names := map[string]int{}
	for _, psu := range supplies {
		names[psu.Name]++
	}
	for _, psu := range supplies {
		if absent(psu.Status) {
			continue
		}
		// HPE iLO names every supply "HpeServerPowerSupply"; the slot then takes the MemberId so each supply
		// keeps its own component row (unique by kind and slot).
		slot := psu.Name
		if (names[psu.Name] > 1 || slot == "") && psu.MemberID != "" {
			slot = strings.TrimSpace(psu.Name + " " + psu.MemberID)
		}
		c := contract.Component{Kind: contract.ComponentPSU, Slot: slot, SerialNumber: psu.SerialNumber}
		if psu.PowerCapacityWatts > 0 {
			c.Details = map[string]any{"capacityWatts": psu.PowerCapacityWatts}
		}
		out = append(out, c)
	}
	return out
}

// Components lists the parts of one system: its own processors, memory and drives, and the adapters and power
// supplies of the chassis it is linked to.
func Components(inv *Inventory, s systemDoc) []contract.Component {
	p := inv.Parts[s.ID]
	out := processorParts(p)
	out = append(out, memoryParts(p)...)
	out = append(out, driveParts(p)...)
	for _, ref := range s.Links.Chassis {
		if id := chassisIDOf(inv, ref.ID); id != "" {
			out = append(out, chassisParts(inv, id)...)
		}
	}
	return out
}

// chassisIDOf maps a chassis @odata.id link to the Id the inventory keys power and adapters by.
func chassisIDOf(inv *Inventory, odataID string) string {
	for _, ch := range inv.Chassis {
		if ch.ODataID == odataID || strings.HasSuffix(odataID, "/"+ch.ID) {
			return ch.ID
		}
	}
	return ""
}
