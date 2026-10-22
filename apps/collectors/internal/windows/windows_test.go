// T-038 REQ-DISC-002 — parses a Windows inventory document shaped like the collector script's
// ConvertTo-Json output and checks host/vm classification, OS, interfaces, IPs, listeners and
// software emission. Recordings from real hosts live under packages/testing/fixtures/vendor/wmi.
package windows

import (
	"testing"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

const physical = `{"computer":{"Name":"SQL-RYD-01","Domain":"corp.example","Manufacturer":"HPE","Model":"ProLiant DL380 Gen11","TotalPhysicalMemory":274877906944,"NumberOfProcessors":2,"NumberOfLogicalProcessors":64,"HypervisorPresent":false,"DomainRole":3,"PartOfDomain":true},
"bios":{"SerialNumber":"CZJ3240ABC","SMBIOSBIOSVersion":"U54 v2.10","Manufacturer":"HPE"},
"product":{"UUID":"36353530-3836-5A43-4A33-323430414243","IdentifyingNumber":"CZJ3240ABC","Vendor":"HPE","Name":"ProLiant DL380 Gen11"},
"os":{"Caption":"Microsoft Windows Server 2022 Datacenter","Version":"10.0.20348","BuildNumber":"20348","OSArchitecture":"64-bit","InstallDate":"/Date(1700000000000)/","LastBootUpTime":"/Date(1720000000000)/"},
"cpu":[{"Name":"Intel(R) Xeon(R) Gold 6430","NumberOfCores":16,"NumberOfLogicalProcessors":32},{"Name":"Intel(R) Xeon(R) Gold 6430","NumberOfCores":16,"NumberOfLogicalProcessors":32}],
"nics":[{"Name":"Ethernet 2","InterfaceDescription":"Broadcom NetXtreme-E","InterfaceIndex":12,"MacAddress":"B4-7A-F1-11-22-33","LinkSpeed":"25 Gbps","Status":"Up"},{"Name":"Ethernet 3","InterfaceDescription":"Broadcom NetXtreme-E #2","InterfaceIndex":13,"MacAddress":"B4-7A-F1-11-22-34","LinkSpeed":"25 Gbps","Status":"Disconnected"}],
"ips":[{"InterfaceIndex":12,"IPAddress":"10.120.5.40","PrefixLength":24,"AddressFamily":2},{"InterfaceIndex":12,"IPAddress":"fe80::1c2d:3e4f:5a6b:7c8d","PrefixLength":64,"AddressFamily":23},{"InterfaceIndex":1,"IPAddress":"127.0.0.1","PrefixLength":8,"AddressFamily":2}],
"tcp":[{"LocalAddress":"0.0.0.0","LocalPort":1433,"OwningProcess":4120},{"LocalAddress":"0.0.0.0","LocalPort":3389,"OwningProcess":988},{"LocalAddress":"::","LocalPort":1433,"OwningProcess":4120}],
"udp":[{"LocalAddress":"0.0.0.0","LocalPort":1434,"OwningProcess":5100}],
"processes":[{"Id":4120,"ProcessName":"sqlservr","Path":"C:\\Program Files\\Microsoft SQL Server\\MSSQL16.MSSQLSERVER\\MSSQL\\Binn\\sqlservr.exe"},{"Id":988,"ProcessName":"svchost","Path":null},{"Id":5100,"ProcessName":"sqlbrowser","Path":null}],
"software":[{"DisplayName":"Microsoft SQL Server 2022 (64-bit)","DisplayVersion":"16.0.4105.2","Publisher":"Microsoft Corporation","InstallDate":"20240115","InstallLocation":"C:\\Program Files\\Microsoft SQL Server\\"},{"DisplayName":"Microsoft SQL Server 2022 (64-bit)","DisplayVersion":"16.0.4105.2","Publisher":"Microsoft Corporation","InstallDate":"20240115","InstallLocation":null}],
"services":[{"Name":"MSSQLSERVER","DisplayName":"SQL Server (MSSQLSERVER)","State":"Running","StartMode":"Auto","PathName":"x","StartName":"CORP\\svc-sql"},{"Name":"Spooler","DisplayName":"Print Spooler","State":"Stopped","StartMode":"Disabled","PathName":"y","StartName":"LocalSystem"}],
"hotfixes":[{"HotFixID":"KB5041160","Description":"Security Update","InstalledOn":"/Date(1723000000000)/"}],
"disks":[{"DeviceID":"C:","Size":255000000000,"FreeSpace":100000000000,"FileSystem":"NTFS","VolumeName":"System"},{"DeviceID":"D:","Size":2000000000000,"FreeSpace":800000000000,"FileSystem":"NTFS","VolumeName":"Data"}],
"fqdn":"sql-ryd-01.corp.example","features":["FileAndStorage-Services","Web-Server"]}`

func count(cis []contract.ObservedCi, typ string) int {
	n := 0
	for _, c := range cis {
		if c.Type == typ {
			n++
		}
	}
	return n
}

func TestPhysicalServer(t *testing.T) {
	inv, err := Parse("Some banner line\n" + physical)
	if err != nil {
		t.Fatal(err)
	}
	obs := Emit(inv, contract.Target{Kind: "host", Value: "10.120.5.40"}, []byte(physical), time.Now())
	host := obs.Cis[0]
	if host.Type != typeHost || host.Identity["serialNumber"] != "CZJ3240ABC" || host.Identity["systemUuid"] != "36353530-3836-5a43-4a33-323430414243" || host.Identity["fqdn"] != "sql-ryd-01.corp.example" || host.Identity["primaryMac"] != "b4:7a:f1:11:22:33" {
		t.Fatalf("host identity wrong: %+v", host.Identity)
	}
	if host.Attributes["cpuCores"] != 32 || host.Attributes["cpuCount"] != 64 || host.Attributes["memoryMb"] != int64(262144) || host.Attributes["diskBytes"] != int64(2255000000000) {
		t.Fatalf("host attributes wrong: %+v", host.Attributes)
	}
	if count(obs.Cis, typeOS) != 1 || count(obs.Cis, typeInterface) != 2 || count(obs.Cis, typeIP) != 1 || count(obs.Cis, typeListener) != 3 || count(obs.Cis, typeSoftware) != 1 || count(obs.Cis, typeInstall) != 1 {
		t.Fatalf("unexpected CI mix: os=%d if=%d ip=%d ls=%d sw=%d inst=%d", count(obs.Cis, typeOS), count(obs.Cis, typeInterface), count(obs.Cis, typeIP), count(obs.Cis, typeListener), count(obs.Cis, typeSoftware), count(obs.Cis, typeInstall))
	}
	for _, ci := range obs.Cis {
		if ci.Type == typeListener && ci.Identity["port"] == "1433" && ci.Attributes["process"] != "sqlservr" {
			t.Fatalf("listener process not resolved: %+v", ci.Attributes)
		}
		if ci.Type == typeOS && (ci.Identity["family"] != "windows" || ci.Identity["version"] != "10.0.20348") {
			t.Fatalf("os wrong: %+v", ci.Identity)
		}
	}
	services, _ := host.Attributes["runningServices"].([]map[string]any)
	if len(services) != 1 {
		t.Fatalf("expected one running service, got %+v", services)
	}
}

func TestVirtualMachineClassification(t *testing.T) {
	doc := `{"computer":{"Name":"APP-01","Domain":"corp.example","Manufacturer":"VMware, Inc.","Model":"VMware7,1","HypervisorPresent":true},"bios":{"SerialNumber":"VMware-42 35 00 01"},"product":{"UUID":"42350001-0000-0000-0000-000000000001"},"os":{"Caption":"Microsoft Windows Server 2019 Standard","Version":"10.0.17763","BuildNumber":"17763"},"fqdn":"app-01.corp.example"}`
	inv, err := Parse(doc)
	if err != nil {
		t.Fatal(err)
	}
	obs := Emit(inv, contract.Target{Kind: "host", Value: "10.120.9.9"}, []byte(doc), time.Now())
	vm := obs.Cis[0]
	if vm.Type != typeVM || vm.Identity["instanceUuid"] != "42350001-0000-0000-0000-000000000001" || vm.Identity["hypervisorRef"] != "VMware, Inc." || vm.Identity["fqdn"] != "app-01.corp.example" {
		t.Fatalf("vm identity wrong: %+v", vm)
	}
}

func TestParseRejectsNonJson(t *testing.T) {
	if _, err := Parse("Access is denied."); err == nil {
		t.Fatal("expected parse error")
	}
}
