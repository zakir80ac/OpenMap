// T-039 REQ-DISC-006 — parses a Hyper-V inventory document shaped like the collector script's
// output (clustered host, two VMs, one with KVP guest data) and checks the emitted CIs and
// relationships. Recordings from real hosts live under packages/testing/fixtures/vendor/hyperv.
package hyperv

import (
	"testing"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

const doc = `{"host":{"Name":"HV-RYD-01","FullyQualifiedDomainName":"hv-ryd-01.corp.example","LogicalProcessorCount":96,"MemoryCapacity":1099511627776,"VirtualMachinePath":"C:\\ClusterStorage\\Volume1"},
"bios":{"SerialNumber":"MXQ4120ABC"},"computer":{"Manufacturer":"HPE","Model":"ProLiant DL385 Gen11","Domain":"corp.example"},"product":{"UUID":"31353436-3030-4D58-5134-313230414243"},
"os":{"Caption":"Microsoft Windows Server 2022 Datacenter","Version":"10.0.20348","BuildNumber":"20348"},
"cluster":{"Name":"HV-RYD-CL01","Id":"c0ffee00-1111-2222-3333-444455556666","Domain":"corp.example"},
"nodes":[{"Name":"HV-RYD-01","State":0},{"Name":"HV-RYD-02","State":0}],
"switches":[{"Name":"vSwitch-Prod","Id":"sw-1","SwitchType":2,"NetAdapterInterfaceDescription":"Microsoft Network Adapter Multiplexor Driver"}],
"vms":[
 {"Name":"FS-RYD-01","Id":"A1B2C3D4-0000-4000-8000-000000000001","State":2,"ProcessorCount":4,"MemoryAssigned":17179869184,"MemoryStartup":8589934592,"DynamicMemoryEnabled":true,"Generation":2,"Version":"10.0","ComputerName":"HV-RYD-01","IsClustered":true,"Notes":"","Uptime":"12.03:22:11","IntegrationServicesState":"Up to date",
  "Kvp":{"OSName":"Windows Server 2022 Standard","OSVersion":"10.0.20348","FullyQualifiedDomainName":"fs-ryd-01.corp.example","NetworkAddressIPv4":"10.130.4.21"},
  "Nics":[{"Name":"Network Adapter","MacAddress":"00155D010A01","SwitchName":"vSwitch-Prod","Status":2,"IPAddresses":["10.130.4.21","fe80::1"]}],
  "Disks":[{"Path":"C:\\ClusterStorage\\Volume1\\FS-RYD-01\\os.vhdx","ControllerType":"SCSI","Size":137438953472,"FileSize":60000000000,"VhdFormat":"VHDX","VhdType":"Dynamic"},{"Path":"C:\\ClusterStorage\\Volume1\\FS-RYD-01\\data.vhdx","ControllerType":"SCSI","Size":2199023255552,"FileSize":900000000000,"VhdFormat":"VHDX","VhdType":"Dynamic"}]},
 {"Name":"LAB-TEMPLATE","Id":"A1B2C3D4-0000-4000-8000-000000000002","State":3,"ProcessorCount":2,"MemoryAssigned":0,"MemoryStartup":4294967296,"Generation":2,"Version":"10.0","ComputerName":"HV-RYD-01","IsClustered":false,"Kvp":{},"Nics":[{"Name":"Network Adapter","MacAddress":"000000000000","SwitchName":"","IPAddresses":[]}],"Disks":[]}
]}`

func count(cis []contract.ObservedCi, typ string) int {
	n := 0
	for _, c := range cis {
		if c.Type == typ {
			n++
		}
	}
	return n
}

func TestParseAndEmit(t *testing.T) {
	inv, err := Parse(doc)
	if err != nil {
		t.Fatal(err)
	}
	obs := Emit(inv, contract.Target{Kind: "host", Value: "10.130.0.11"}, []byte(doc), time.Now())
	if count(obs.Cis, typeHost) != 1 || count(obs.Cis, typeHypervisor) != 1 || count(obs.Cis, typeCluster) != 1 || count(obs.Cis, typeVM) != 2 || count(obs.Cis, typeOS) != 2 || count(obs.Cis, typeIP) != 1 {
		t.Fatalf("unexpected CI mix: %+v", obs.Cis)
	}
	for _, ci := range obs.Cis {
		switch {
		case ci.Type == typeVM && ci.Name == "FS-RYD-01":
			if ci.Identity["instanceUuid"] != "a1b2c3d4-0000-4000-8000-000000000001" || ci.Identity["hypervisorRef"] != "hv-ryd-01.corp.example" || ci.Identity["fqdn"] != "fs-ryd-01.corp.example" {
				t.Fatalf("vm identity wrong: %+v", ci.Identity)
			}
			if ci.Attributes["powerState"] != "running" || ci.Attributes["memoryMb"] != int64(16384) || ci.Attributes["diskBytes"] != int64(2336462209024) || ci.Attributes["diskCount"] != 2 {
				t.Fatalf("vm attributes wrong: %+v", ci.Attributes)
			}
			macs, _ := ci.Attributes["macAddresses"].([]string)
			if len(macs) != 1 || macs[0] != "00:15:5d:01:0a:01" {
				t.Fatalf("mac normalisation wrong: %+v", macs)
			}
		case ci.Type == typeVM && ci.Name == "LAB-TEMPLATE":
			if ci.Attributes["powerState"] != "stopped" || ci.Identity["fqdn"] != "" {
				t.Fatalf("stopped vm wrong: %+v", ci)
			}
		case ci.Type == typeCluster:
			if ci.Identity["clusterId"] != "c0ffee00-1111-2222-3333-444455556666" || ci.Attributes["nodeCount"] != 2 {
				t.Fatalf("cluster wrong: %+v", ci)
			}
		case ci.Type == typeHost:
			if ci.Identity["serialNumber"] != "MXQ4120ABC" || ci.Identity["systemUuid"] != "31353436-3030-4d58-5134-313230414243" {
				t.Fatalf("host wrong: %+v", ci.Identity)
			}
		}
	}
	rels := map[string]int{}
	for _, r := range obs.Relationships {
		rels[r.Type]++
	}
	if rels[relHostedOn] != 1 || rels[relMemberOf] != 1 || rels[relRunsOn] != 2 || rels[relInstalledOn] != 2 || rels[relUsesIP] != 1 {
		t.Fatalf("relationship mix wrong: %+v", rels)
	}
}

func TestStandaloneHostWithoutCluster(t *testing.T) {
	inv, err := Parse(`{"host":{"Name":"HV-LAB","FullyQualifiedDomainName":"hv-lab.corp.example"},"bios":{"SerialNumber":"X"},"product":{"UUID":"u"},"os":{"Caption":"Microsoft Windows Server 2019 Standard","Version":"10.0.17763"},"cluster":null,"nodes":[],"switches":[],"vms":[]}`)
	if err != nil {
		t.Fatal(err)
	}
	obs := Emit(inv, contract.Target{Kind: "host", Value: "hv-lab"}, nil, time.Now())
	if count(obs.Cis, typeCluster) != 0 || count(obs.Cis, typeHypervisor) != 1 {
		t.Fatalf("unexpected CI mix: %+v", obs.Cis)
	}
}
