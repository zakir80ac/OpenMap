// REQ-CMDB-014 (ADR-037) — the part list a collector reports on an observed CI's `components`; mirrors
// packages/contracts/src/component.ts. The reconciler keeps one row per kind and slot in ci_components.
package contract

// Component kinds (COMPONENT_KINDS in the TypeScript contract).
const (
	ComponentCPU        = "cpu"
	ComponentMemory     = "memory"
	ComponentDisk       = "disk"
	ComponentNIC        = "nic"
	ComponentHBA        = "hba"
	ComponentGPU        = "gpu"
	ComponentPSU        = "psu"
	ComponentController = "controller"
)

// Component is one part inside a CI, unique by Kind and Slot within it.
type Component struct {
	Kind          string         `json:"kind"`
	Slot          string         `json:"slot"`
	Model         string         `json:"model,omitempty"`
	Manufacturer  string         `json:"manufacturer,omitempty"`
	SerialNumber  string         `json:"serialNumber,omitempty"`
	PartNumber    string         `json:"partNumber,omitempty"`
	CapacityBytes float64        `json:"capacityBytes,omitempty"`
	Firmware      string         `json:"firmware,omitempty"`
	Details       map[string]any `json:"details,omitempty"`
}
