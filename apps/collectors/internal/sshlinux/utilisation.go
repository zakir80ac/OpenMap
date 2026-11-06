// REQ-CMDB-034 — utilisation a Linux host reports during the visit: CPU busy share between two /proc/stat reads a
// second apart, memory in use from MemTotal and MemAvailable, and the fullest real filesystem from df. Sampled as
// host.* (or vm.* for a guest) metrics on the host's observation.
package sshlinux

import (
	"strconv"
	"strings"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

// cpuSampleSeconds is the gap between the two CPU counter reads (UTILISATION.cpuSampleSeconds in @openmap/constants).
const cpuSampleSeconds = 1

// /proc/stat "cpu" columns: user nice system idle iowait irq softirq steal; idle time is idle plus iowait.
const (
	statIdleColumn   = 4
	statIOWaitColumn = 5
)

var utilisationCommands = []command{
	{"cpu_stat", "head -1 /proc/stat; sleep " + strconv.Itoa(cpuSampleSeconds) + "; head -1 /proc/stat"},
	{"mem_available", "grep -E '^(MemTotal|MemAvailable):' /proc/meminfo 2>/dev/null || true"},
}

func init() {
	Commands = append(Commands, utilisationCommands...)
}

// Utilisation is what one visit measured; a negative value means not measured.
type Utilisation struct {
	CPUPercent    float64
	MemoryPercent float64
	DiskPercent   float64
	DiskMount     string
}

func cpuTimes(line string) (idle, total float64, ok bool) {
	f := strings.Fields(line)
	if len(f) <= statIOWaitColumn || f[0] != "cpu" {
		return 0, 0, false
	}
	for i, v := range f[1:] {
		n, err := strconv.ParseFloat(v, 64)
		if err != nil {
			return 0, 0, false
		}
		total += n
		if i+1 == statIdleColumn || i+1 == statIOWaitColumn {
			idle += n
		}
	}
	return idle, total, true
}

// ParseCPUStat reads the two aggregate "cpu" lines and returns the busy share between them, or -1.
func ParseCPUStat(text string) float64 {
	var lines []string
	for _, l := range strings.Split(text, "\n") {
		if strings.HasPrefix(l, "cpu ") {
			lines = append(lines, l)
		}
	}
	if len(lines) < 2 {
		return -1
	}
	idle1, total1, ok1 := cpuTimes(lines[0])
	idle2, total2, ok2 := cpuTimes(lines[len(lines)-1])
	dt := total2 - total1
	if !ok1 || !ok2 || dt <= 0 {
		return -1
	}
	return (1 - (idle2-idle1)/dt) * contract.PercentOfWhole
}

// ParseMemoryUsed reads MemTotal and MemAvailable and returns the share in use, or -1.
func ParseMemoryUsed(text string) float64 {
	var total, available float64 = -1, -1
	for _, line := range strings.Split(text, "\n") {
		f := strings.Fields(line)
		if len(f) < 2 {
			continue
		}
		v, err := strconv.ParseFloat(f[1], 64)
		if err != nil {
			continue
		}
		switch f[0] {
		case "MemTotal:":
			total = v
		case "MemAvailable:":
			available = v
		}
	}
	if total <= 0 || available < 0 {
		return -1
	}
	return (total - available) / total * contract.PercentOfWhole
}

// FullestMount returns the used share and path of the fullest filesystem, or -1.
func FullestMount(mounts []Mount) (float64, string) {
	best, path := -1.0, ""
	for _, m := range mounts {
		if m.SizeKB <= 0 {
			continue
		}
		if p := float64(m.UsedKB) / float64(m.SizeKB) * contract.PercentOfWhole; p > best {
			best, path = p, m.Path
		}
	}
	return best, path
}

// MeasureUtilisation reads the visit's outputs.
func MeasureUtilisation(parts map[string]string, mounts []Mount) Utilisation {
	disk, mount := FullestMount(mounts)
	return Utilisation{CPUPercent: ParseCPUStat(parts["cpu_stat"]), MemoryPercent: ParseMemoryUsed(parts["mem_available"]), DiskPercent: disk, DiskMount: mount}
}

// Samples turns a measurement into metric samples on the host (or VM) reference.
func (u Utilisation) Samples(ref contract.CiRef, at time.Time) []contract.MetricSample {
	cpu, memory, disk := contract.MetricHostCPU, contract.MetricHostMemory, contract.MetricHostDisk
	if ref.Type == typeVM {
		cpu, memory, disk = contract.MetricVMCPU, contract.MetricVMMemory, contract.MetricVMDisk
	}
	out := []contract.MetricSample{}
	add := func(metric string, value float64, labels map[string]string) {
		if value >= 0 {
			out = append(out, contract.MetricSample{Ci: ref, Metric: metric, Ts: at, Value: value, Unit: contract.UnitPercent, Labels: labels})
		}
	}
	add(cpu, u.CPUPercent, map[string]string{})
	add(memory, u.MemoryPercent, map[string]string{})
	add(disk, u.DiskPercent, map[string]string{contract.LabelMount: u.DiskMount})
	return out
}
