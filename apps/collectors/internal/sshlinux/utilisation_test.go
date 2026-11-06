// T-203 REQ-CMDB-034 — Linux utilisation: CPU busy share between two /proc/stat reads, memory in use from MemAvailable,
// the fullest filesystem, host.* samples on a server and vm.* samples on a guest, and unreadable inputs skipped.
package sshlinux

import (
	"math"
	"strings"
	"testing"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

const tolerance = 1e-9

func near(a, b float64) bool { return math.Abs(a-b) < tolerance }

func TestLinuxUtilisation(t *testing.T) {
	// 1000 jiffies elapse, of which idle 700 and iowait 100: busy 20 %.
	stat := "cpu  100 0 100 1000 0 0 0 0 0 0\ncpu  200 0 200 1700 100 0 0 0 0 0\n"
	if got := ParseCPUStat(stat); !near(got, 20) {
		t.Fatalf("cpu busy = %v", got)
	}
	if ParseCPUStat("cpu  1 2 3 4 5\n") != -1 || ParseCPUStat("") != -1 {
		t.Fatal("one read must not measure")
	}
	if got := ParseMemoryUsed("MemTotal:       16000000 kB\nMemAvailable:    4000000 kB\n"); !near(got, 75) {
		t.Fatalf("memory used = %v", got)
	}
	if ParseMemoryUsed("MemTotal: 16000000 kB\n") != -1 {
		t.Fatal("no MemAvailable must not measure")
	}
	disk, mount := FullestMount([]Mount{{Path: "/", SizeKB: 100, UsedKB: 40}, {Path: "/var", SizeKB: 200, UsedKB: 180}, {Path: "/empty", SizeKB: 0}})
	if !near(disk, 90) || mount != "/var" {
		t.Fatalf("fullest = %v %s", disk, mount)
	}

	parts := map[string]string{"cpu_stat": stat, "mem_available": "MemTotal: 100 kB\nMemAvailable: 60 kB\n"}
	u := MeasureUtilisation(parts, []Mount{{Path: "/", SizeKB: 10, UsedKB: 5}})
	at := time.Unix(0, 0)
	host := u.Samples(contract.CiRef{Type: typeHost, Identity: map[string]string{"fqdn": "a"}}, at)
	if len(host) != 3 || host[0].Metric != contract.MetricHostCPU || host[2].Labels[contract.LabelMount] != "/" || host[1].Unit != contract.UnitPercent {
		t.Fatalf("host samples: %+v", host)
	}
	guest := u.Samples(contract.CiRef{Type: typeVM, Identity: map[string]string{"fqdn": "g"}}, at)
	for _, s := range guest {
		if !strings.HasPrefix(s.Metric, "vm.") {
			t.Fatalf("guest sample %s", s.Metric)
		}
	}
	none := Utilisation{CPUPercent: -1, MemoryPercent: -1, DiskPercent: -1}.Samples(contract.CiRef{Type: typeHost}, at)
	if len(none) != 0 {
		t.Fatalf("unmeasured must not sample: %+v", none)
	}

	obs := Emit(Assemble(map[string]string{"hostname": "srv", "cpu_stat": stat, "mem_available": "MemTotal: 100 kB\nMemAvailable: 60 kB\n"}), contract.Target{Kind: "host", Value: "srv"}, nil, at)
	if len(obs.Samples) != 2 {
		t.Fatalf("emitted samples: %+v", obs.Samples)
	}
	for _, c := range utilisationCommands {
		if !strings.Contains(Script(), "@@OPENMAP:"+c.Key+"@@") {
			t.Fatalf("script lacks %s", c.Key)
		}
	}
}
