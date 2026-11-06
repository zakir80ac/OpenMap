// T-195 REQ-CMDB-014 — Windows part inventory: sockets, DIMMs, physical drives, hardware NICs only and FC initiator
// ports, carried on the host's `components` attribute.
package windows

import (
	"testing"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

const partsDoc = `{"computer":{"Name":"APP01","Domain":"corp.example","Manufacturer":"Dell Inc.","Model":"PowerEdge R650","TotalPhysicalMemory":68719476736,"NumberOfProcessors":2},
"bios":{"SerialNumber":"7XK2M3"},"product":{"UUID":"4C4C4544-0058-4B10-8032-B7C04F4D3333"},"os":{"Caption":"Microsoft Windows Server 2022 Standard","Version":"10.0.20348"},
"cpu":[{"DeviceID":"CPU0","SocketDesignation":"CPU1","Name":"Intel(R) Xeon(R) Gold 6338 CPU @ 2.00GHz","Manufacturer":"GenuineIntel","NumberOfCores":32,"NumberOfLogicalProcessors":64},
       {"DeviceID":"CPU1","SocketDesignation":"CPU2","Name":"Intel(R) Xeon(R) Gold 6338 CPU @ 2.00GHz","Manufacturer":"GenuineIntel","NumberOfCores":32,"NumberOfLogicalProcessors":64}],
"nics":[{"Name":"NIC1","InterfaceDescription":"Broadcom NetXtreme E-Series","InterfaceIndex":4,"MacAddress":"B0-26-28-00-00-01","LinkSpeed":"25 Gbps","Status":"Up","HardwareInterface":true,"DriverVersion":"222.0.152.0"},
        {"Name":"vEthernet (Default Switch)","InterfaceDescription":"Hyper-V Virtual Ethernet Adapter","InterfaceIndex":9,"MacAddress":"00-15-5D-00-00-01","LinkSpeed":"10 Gbps","Status":"Up","HardwareInterface":false}],
"memory":[{"BankLabel":"","DeviceLocator":"A1","Capacity":34359738368,"Manufacturer":"00AD063200AD","SerialNumber":"8A1B2C3D","PartNumber":"HMA84GR7DJR4N-XN","ConfiguredClockSpeed":3200}],
"drives":[{"Index":0,"Model":"DELL PERC H755 SCSI Disk Device","SerialNumber":"0050ab12","Size":959656755200,"FirmwareRevision":"5.16","InterfaceType":"SCSI","MediaType":"Fixed hard disk media"}],
"hbas":[{"InstanceName":"PCI\\VEN_10DF\\0_0","PortAddress":"10000090FA000001","NodeAddress":"20000090FA000001"}],
"fqdn":"app01.corp.example"}`

func TestWindowsComponents(t *testing.T) {
	inv, err := Parse(partsDoc)
	if err != nil {
		t.Fatal(err)
	}
	parts := Components(inv)
	count := map[string]int{}
	for _, p := range parts {
		count[p.Kind]++
	}
	if count["cpu"] != 2 || count["memory"] != 1 || count["disk"] != 1 || count["nic"] != 1 || count["hba"] != 1 {
		t.Fatalf("counts: %v", count)
	}
	if parts[0].Slot != "CPU1" || parts[0].Details["cores"] != 32 {
		t.Fatalf("socket: %+v", parts[0])
	}
	for _, p := range parts {
		if p.Kind == "hba" && p.Details["wwpn"] != "10000090fa000001" {
			t.Fatalf("hba: %+v", p)
		}
		if p.Kind == "memory" && (p.Slot != "A1" || p.CapacityBytes != 34359738368) {
			t.Fatalf("dimm: %+v", p)
		}
	}
	obs := Emit(inv, contract.Target{Kind: "host", Value: "app01"}, []byte(partsDoc), time.Unix(0, 0))
	if len(obs.Cis[0].Components) != len(parts) {
		t.Fatalf("components: %#v", obs.Cis[0].Components)
	}
}
