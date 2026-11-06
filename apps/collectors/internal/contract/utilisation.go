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
	UnitWatts        = "W"
	LabelMount       = "mount"
	PercentOfWhole   = 100.0
)
