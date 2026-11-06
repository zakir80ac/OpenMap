// T-194 REQ-CMDB-014 — Linux part inventory: CPU sockets, block devices, physical NICs, FC HBAs and DIMMs from the
// read-only commands, and the `components` attribute on the emitted host.
package sshlinux

import (
	"strings"
	"testing"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

const cpuinfoTwoSockets = `processor	: 0
vendor_id	: GenuineIntel
model name	: Intel(R) Xeon(R) Gold 6338 CPU @ 2.00GHz
physical id	: 0
cpu cores	: 32

processor	: 1
vendor_id	: GenuineIntel
model name	: Intel(R) Xeon(R) Gold 6338 CPU @ 2.00GHz
physical id	: 1
cpu cores	: 32

processor	: 2
vendor_id	: GenuineIntel
model name	: Intel(R) Xeon(R) Gold 6338 CPU @ 2.00GHz
physical id	: 0
cpu cores	: 32
`

const dmiMemory = `# dmidecode 3.3
Handle 0x0040, DMI type 17, 92 bytes
Memory Device
	Size: 32 GB
	Locator: DIMM_A1
	Bank Locator: P0 CHANNEL A
	Type: DDR4
	Speed: 3200 MT/s
	Manufacturer: Samsung
	Serial Number: 0A1B2C3D
	Part Number: M393A4K40EB3-CWE

Handle 0x0041, DMI type 17, 92 bytes
Memory Device
	Size: No Module Installed
	Locator: DIMM_A2
`

func TestComponentsFromCommands(t *testing.T) {
	parts := map[string]string{
		"cpuinfo":     cpuinfoTwoSockets,
		"dmi_memory":  dmiMemory,
		"lsblk_pairs": "NAME=\"sda\" SIZE=\"960197124096\" TYPE=\"disk\" MODEL=\"SAMSUNG MZ7L3960\" SERIAL=\"S6KNNA0T\" VENDOR=\"ATA     \" ROTA=\"0\" TRAN=\"sata\" REV=\"JXTC104Q\"\nNAME=\"sr0\" SIZE=\"1073741312\" TYPE=\"rom\" MODEL=\"DVD\" SERIAL=\"\" VENDOR=\"\" ROTA=\"1\" TRAN=\"sata\" REV=\"\"\nNAME=\"loop0\" SIZE=\"1\" TYPE=\"loop\" MODEL=\"\" SERIAL=\"\" VENDOR=\"\" ROTA=\"0\" TRAN=\"\" REV=\"\"",
		"nics":        "eno1\t3c:ec:ef:00:00:01\t10000\tice\neno2\t3c:ec:ef:00:00:02\t-1\tice\n",
		"fc_hosts":    "host3\t0x10000090fa000001\t0x20000090fa000001\t16 Gbit\tOnline\n",
	}
	got := Components(parts)
	byKind := map[string][]contract.Component{}
	for _, c := range got {
		byKind[c.Kind] = append(byKind[c.Kind], c)
	}
	if len(byKind["cpu"]) != 2 || byKind["cpu"][0].Details["threads"] != 2 || byKind["cpu"][0].Details["cores"] != 32 {
		t.Fatalf("cpu sockets: %+v", byKind["cpu"])
	}
	if len(byKind["memory"]) != 1 || byKind["memory"][0].Slot != "P0 CHANNEL A DIMM_A1" || byKind["memory"][0].CapacityBytes != 32*(1<<30) || byKind["memory"][0].SerialNumber != "0A1B2C3D" {
		t.Fatalf("memory: %+v", byKind["memory"])
	}
	if len(byKind["disk"]) != 1 || byKind["disk"][0].SerialNumber != "S6KNNA0T" || byKind["disk"][0].Manufacturer != "ATA" || byKind["disk"][0].Details["media"] != "ssd" {
		t.Fatalf("disks: %+v", byKind["disk"])
	}
	if len(byKind["nic"]) != 2 || byKind["nic"][0].Details["speedMbps"] != 10000 || byKind["nic"][1].Details["speedMbps"] != nil || byKind["nic"][0].Model != "ice" {
		t.Fatalf("nics: %+v", byKind["nic"])
	}
	if len(byKind["hba"]) != 1 || byKind["hba"][0].Details["wwpn"] != "0x10000090fa000001" {
		t.Fatalf("hba: %+v", byKind["hba"])
	}

	f := Assemble(parts)
	obs := Emit(f, contract.Target{Kind: "host", Value: "server-01"}, nil, time.Unix(0, 0))
	if len(obs.Cis[0].Components) != len(got) {
		t.Fatalf("host components: %#v", obs.Cis[0].Components)
	}
}

func TestComponentCommandsAreInScript(t *testing.T) {
	script := Script()
	for _, c := range componentCommands {
		if !strings.Contains(script, "@@OPENMAP:"+c.Key+"@@") {
			t.Fatalf("script lacks %s", c.Key)
		}
	}
}
