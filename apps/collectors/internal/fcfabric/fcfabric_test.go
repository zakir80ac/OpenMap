// T-047 REQ-DISC-015 — parses FOS 9.x and NX-OS 9.x transcripts in the documented command formats
// and checks switch, fabric, zone and port emission. Real switch recordings live under
// packages/testing/fixtures/vendor/fc_fabric.
package fcfabric

import (
	"testing"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

var brocade = map[string]string{
	"version": "Kernel:     4.19.0\nFabric OS:  v9.1.1c\nMade on:    Thu Jun 15 02:11:58 2023\n",
	"switchshow": `switchName:	BRCD-RYD-A1
switchType:	170.0
switchState:	Online
switchMode:	Native
switchRole:	Principal
switchDomain:	1
switchId:	fffc01
switchWwn:	10:00:C4:F5:7C:11:22:33
zoning:		ON (CFG_PROD)
switchBeacon:	OFF

Index Port Address Media Speed State     Proto
==================================================
   0   0   010000   id    N32   Online      FC  F-Port  50:06:01:60:AA:BB:CC:01
   1   1   010100   id    N32   Online      FC  F-Port  10:00:00:90:FA:AA:BB:01
   2   2   010200   id    N32   No_Light    FC
   3   3   010300   --    N32   No_Module   FC  (No POD License) Disabled
`,
	"chassisshow": "Chassis Family:          FC32-48\nChassis Backplane Revision: 1\nSerial Num:              FHX3210A1BC\n",
	"fabricshow": `Switch ID   Worldwide Name           Enet IP Addr    FC IP Addr      Name
-------------------------------------------------------------------------
  1: fffc01 10:00:c4:f5:7c:11:22:33 10.180.0.11     0.0.0.0        >"BRCD-RYD-A1"
  2: fffc02 10:00:c4:f5:7c:44:55:66 10.180.0.12     0.0.0.0         "BRCD-RYD-A2"

The Fabric has 2 switches
`,
	"nsshow": `{
 Type Pid    COS     PortName                NodeName                 TTL(sec)
 N    010000;      3;50:06:01:60:aa:bb:cc:01;50:06:01:60:aa:bb:cc:00; na
    FC4s: FCP
    PortSymb: [26] "PURE FlashArray CT0.FC0"
    NodeSymb: [20] "PURE FlashArray"
    Fabric Port Name: 20:00:c4:f5:7c:11:22:33
    Permanent Port Name: 50:06:01:60:aa:bb:cc:01
    Device type: Physical Target
    Port Index: 0
 N    010100;      3;10:00:00:90:fa:aa:bb:01;20:00:00:90:fa:aa:bb:01; na
    FC4s: FCP
    PortSymb: [34] "Emulex LPe35002 FV14.2 DV14.2 db-ryd-pg-core-01"
    NodeSymb: [20] "db-ryd-pg-core-01"
    Device type: Physical Initiator
    Port Index: 1
The Local Name Server has 2 entries }
`,
	"zoneshow": `Defined configuration:
 cfg:	CFG_PROD	Z_PGCORE01_PURE
 zone:	Z_PGCORE01_PURE
		pgcore01_hba0; pure_ct0_fc0
 alias:	pgcore01_hba0	10:00:00:90:fa:aa:bb:01
 alias:	pure_ct0_fc0	50:06:01:60:aa:bb:cc:01

Effective configuration:
 cfg:	CFG_PROD
 zone:	Z_PGCORE01_PURE
		10:00:00:90:fa:aa:bb:01
		50:06:01:60:aa:bb:cc:01
`,
}

var mds = map[string]string{
	"show version": `Cisco Nexus Operating System (NX-OS) Software
Software
  BIOS: version 2.1.17
  NXOS: version 9.3(2)
Hardware
  cisco MDS 9148T 32G 1 RU FC switch
  Processor Board ID JPG24210ABC
  Device name: MDS-RYD-B1
`,
	"show wwn switch": "Switch WWN is 20:00:00:de:fb:aa:bb:cc\n",
	"show fcdomain domain-list": `VSAN 10
Number of domains: 2
Domain ID              WWN
---------    -----------------------
 0x05(5)     20:0a:00:de:fb:aa:bb:cc [Principal] [Local]
 0x06(6)     20:0a:00:de:fb:dd:ee:ff
`,
	"show fcns database detail": `------------------------
VSAN:10     FCID:0x050000
------------------------
port-wwn (vendor)           :50:06:01:60:aa:bb:cc:02 (Pure)
node-wwn                    :50:06:01:60:aa:bb:cc:00
class                       :3
fc4-types:fc4_features      :scsi-fcp:target
symbolic-port-name          :PURE FlashArray CT1.FC0
symbolic-node-name          :PURE FlashArray
connected interface         :fc1/1
------------------------
VSAN:10     FCID:0x050100
------------------------
port-wwn (vendor)           :10:00:00:90:fa:aa:bb:02 (Emulex)
node-wwn                    :20:00:00:90:fa:aa:bb:02
fc4-types:fc4_features      :scsi-fcp:init
symbolic-port-name          :Emulex LPe35002 db-ryd-pg-core-01
connected interface         :fc1/2
`,
	"show zoneset active": `zoneset name ZS_PROD vsan 10
  zone name Z_PGCORE01_PURE_B vsan 10
  * fcid 0x050100 [pwwn 10:00:00:90:fa:aa:bb:02] [device-alias pgcore01_hba1]
  * fcid 0x050000 [pwwn 50:06:01:60:aa:bb:cc:02] [device-alias pure_ct1_fc0]
`,
	"show interface fc brief": `-------------------------------------------------------------------------------
Interface  Vsan   Admin  Admin   Status          SFP    Oper  Oper   Port
                  Mode   Trunk                          Mode  Speed  Channel
                         Mode                                 (Gbps)
-------------------------------------------------------------------------------
fc1/1      10     auto   on      up               swl    F       32    --
fc1/2      10     auto   on      up               swl    F       32    --
fc1/3      1      auto   on      sfpAbsent        --     --            --
`,
	"show flogi database": `--------------------------------------------------------------------------------
INTERFACE        VSAN    FCID           PORT NAME               NODE NAME
--------------------------------------------------------------------------------
fc1/1            10    0x050000  50:06:01:60:aa:bb:cc:02 50:06:01:60:aa:bb:cc:00
fc1/2            10    0x050100  10:00:00:90:fa:aa:bb:02 20:00:00:90:fa:aa:bb:02
`,
}

func count(cis []contract.ObservedCi, typ string) int {
	n := 0
	for _, c := range cis {
		if c.Type == typ {
			n++
		}
	}
	return n
}

func TestBrocade(t *testing.T) {
	if Detect(brocade, "") != "brocade" {
		t.Fatal("detect failed")
	}
	sw := ParseBrocade(brocade)
	if sw.Name != "BRCD-RYD-A1" || sw.WWNN != "10:00:c4:f5:7c:11:22:33" || sw.Serial != "FHX3210A1BC" || sw.Firmware != "v9.1.1c" || sw.FabricWWN != "10:00:c4:f5:7c:11:22:33" || len(sw.Fabric) != 2 {
		t.Fatalf("switch wrong: %+v", sw)
	}
	if len(sw.Ports) != 4 || sw.Ports["port0"].AttachedWWN != "50:06:01:60:aa:bb:cc:01" || sw.Ports["port2"].State != "No_Light" {
		t.Fatalf("ports wrong: %+v", sw.Ports["port0"])
	}
	if len(sw.NameServer) != 2 || sw.NameServer[0].DeviceType != "Physical Target" || sw.NameServer[1].NodeSymbol != "db-ryd-pg-core-01" {
		t.Fatalf("name server wrong: %+v", sw.NameServer)
	}
	if len(sw.Zones) != 1 || sw.Zones[0].Name != "Z_PGCORE01_PURE" || len(sw.Zones[0].MemberWWNs) != 2 || sw.EffectiveConfig != "CFG_PROD" {
		t.Fatalf("zones wrong: %+v", sw.Zones[0])
	}
	obs := Emit(sw, brocade, contract.Target{Kind: "host", Value: "10.180.0.11"}, "SHA256:x", time.Now())
	if count(obs.Cis, typeSwitch) != 1 || count(obs.Cis, typeFabric) != 1 || count(obs.Cis, typeZone) != 1 || count(obs.Cis, typePort) != 4 {
		t.Fatalf("unexpected CI mix: %+v", obs.Cis)
	}
	for _, ci := range obs.Cis {
		if ci.Type == typePort && ci.Name == "port1" && ci.Attributes["attachedNodeSymbol"] != "db-ryd-pg-core-01" {
			t.Fatalf("port not enriched from name server: %+v", ci.Attributes)
		}
	}
}

func TestMds(t *testing.T) {
	if Detect(mds, "") != "cisco_mds" {
		t.Fatal("detect failed")
	}
	sw := ParseMds(mds)
	if sw.Name != "MDS-RYD-B1" || sw.WWNN != "20:00:00:de:fb:aa:bb:cc" || sw.Serial != "JPG24210ABC" || sw.Model != "MDS 9148T" || sw.Firmware != "NX-OS 9.3(2)" {
		t.Fatalf("switch wrong: %+v", sw)
	}
	if sw.VsanFabrics["10"] != "20:0a:00:de:fb:aa:bb:cc" || sw.Domain != "5" {
		t.Fatalf("fabric wrong: %+v", sw.VsanFabrics)
	}
	if len(sw.Ports) != 3 || sw.Ports["fc1/2"].AttachedWWN != "10:00:00:90:fa:aa:bb:02" || sw.Ports["fc1/2"].Address != "050100" {
		t.Fatalf("ports wrong: %+v", sw.Ports["fc1/2"])
	}
	if len(sw.NameServer) != 2 || sw.NameServer[0].DeviceType != "Physical Target" || sw.NameServer[1].DeviceType != "Physical Initiator" || sw.NameServer[0].Vendor != "Pure" {
		t.Fatalf("fcns wrong: %+v %+v", sw.NameServer[0], sw.NameServer[1])
	}
	if len(sw.Zones) != 1 || sw.Zones[0].Vsan != "10" || len(sw.Zones[0].MemberWWNs) != 2 || sw.Aliases["pgcore01_hba1"][0] != "10:00:00:90:fa:aa:bb:02" {
		t.Fatalf("zones wrong: %+v", sw.Zones[0])
	}
	obs := Emit(sw, mds, contract.Target{Kind: "host", Value: "10.180.0.21"}, "", time.Now())
	if count(obs.Cis, typeSwitch) != 1 || count(obs.Cis, typeFabric) != 1 || count(obs.Cis, typeZone) != 1 || count(obs.Cis, typePort) != 3 {
		t.Fatalf("unexpected CI mix: %+v", obs.Cis)
	}
	for _, ci := range obs.Cis {
		if ci.Type == typeZone && ci.Identity["fabricRef"] != "20:0a:00:de:fb:aa:bb:cc" {
			t.Fatalf("zone fabric ref wrong: %+v", ci.Identity)
		}
		if ci.Type == typeFabric && ci.Attributes["vsan"] != "10" {
			t.Fatalf("fabric vsan missing: %+v", ci.Attributes)
		}
	}
}
