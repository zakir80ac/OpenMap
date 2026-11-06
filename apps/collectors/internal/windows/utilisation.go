// REQ-CMDB-034 — utilisation a Windows host reports during the visit: the _Total processor time share, memory in use
// from Win32_OperatingSystem, and the fullest fixed volume. Sampled as host.* (or vm.* for a guest) metrics.
package windows

import (
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

// Samples lists the utilisation measurements of one inventory document on the host (or VM) reference.
func Samples(inv *Inventory, ref contract.CiRef, at time.Time) []contract.MetricSample {
	cpu, memory, disk := contract.MetricHostCPU, contract.MetricHostMemory, contract.MetricHostDisk
	if ref.Type == typeVM {
		cpu, memory, disk = contract.MetricVMCPU, contract.MetricVMMemory, contract.MetricVMDisk
	}
	out := []contract.MetricSample{}
	sample := func(metric string, value float64, labels map[string]string) {
		out = append(out, contract.MetricSample{Ci: ref, Metric: metric, Ts: at, Value: value, Unit: contract.UnitPercent, Labels: labels})
	}
	if inv.CPULoad != nil {
		sample(cpu, *inv.CPULoad, map[string]string{})
	}
	if total := inv.OS.TotalVisibleMemorySize; total > 0 {
		sample(memory, float64(total-inv.OS.FreePhysicalMemory)/float64(total)*contract.PercentOfWhole, map[string]string{})
	}
	best, mount := -1.0, ""
	for _, d := range inv.Disks {
		if d.Size <= 0 {
			continue
		}
		if p := float64(d.Size-d.FreeSpace) / float64(d.Size) * contract.PercentOfWhole; p > best {
			best, mount = p, d.DeviceID
		}
	}
	if best >= 0 {
		sample(disk, best, map[string]string{contract.LabelMount: mount})
	}
	return out
}
