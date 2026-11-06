// T-203 REQ-CMDB-034 — Windows utilisation: processor time, memory in use and the fullest fixed volume from the
// inventory document, as host.* samples; an unreadable processor counter is skipped.
package windows

import (
	"testing"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

const loadDoc = `{"computer":{"Name":"APP02"},"bios":{"SerialNumber":"7XK2M4"},"product":{"UUID":"4C4C4544-0058-4B10-8032-B7C04F4D3334"},
"os":{"Caption":"Microsoft Windows Server 2022 Standard","Version":"10.0.20348","TotalVisibleMemorySize":33554432,"FreePhysicalMemory":8388608},
"disks":[{"DeviceID":"C:","Size":1000,"FreeSpace":300},{"DeviceID":"D:","Size":1000,"FreeSpace":50}],"cpuLoad":37,"fqdn":"app02.corp.example"}`

func TestWindowsUtilisation(t *testing.T) {
	inv, err := Parse(loadDoc)
	if err != nil {
		t.Fatal(err)
	}
	obs := Emit(inv, contract.Target{Kind: "host", Value: "app02"}, []byte(loadDoc), time.Unix(0, 0))
	got := map[string]contract.MetricSample{}
	for _, s := range obs.Samples {
		got[s.Metric] = s
	}
	if got[contract.MetricHostCPU].Value != 37 || got[contract.MetricHostMemory].Value != 75 {
		t.Fatalf("cpu/memory: %+v", obs.Samples)
	}
	if d := got[contract.MetricHostDisk]; d.Value != 95 || d.Labels[contract.LabelMount] != "D:" {
		t.Fatalf("disk: %+v", d)
	}
	inv.CPULoad = nil
	if n := len(Samples(inv, contract.CiRef{Type: "host"}, time.Unix(0, 0))); n != 2 {
		t.Fatalf("without the counter: %d samples", n)
	}
}
