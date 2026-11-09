// REQ-CMDB-034 — utilisation metric names collectors sample; mirrors packages/contracts/src/utilisation.ts.
package contract

const (
	MetricHostCPU    = "host.cpu.utilisation_percent"
	MetricHostMemory = "host.memory.utilisation_percent"
	MetricHostDisk   = "host.disk.utilisation_percent"
	MetricHostPower  = "host.power.watts"
	MetricVMCPU      = "vm.cpu.utilisation_percent"
	MetricVMMemory   = "vm.memory.utilisation_percent"
	MetricVMDisk     = "vm.disk.utilisation_percent"
	UnitPercent      = "percent"
	// REQ-DCIM-005 (ADR-059): a PDU's total draw and one outlet's draw (the outlet is a power_feed CI).
	MetricPduPower    = "dcim.power.watts"
	MetricOutletPower = "dcim.outlet.watts"
	UnitWatts         = "W"
	LabelMount        = "mount"
	PercentOfWhole    = 100.0
)
