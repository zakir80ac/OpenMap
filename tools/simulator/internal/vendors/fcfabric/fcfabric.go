// REQ-QA-005 REQ-DISC-015 — simulated Fibre Channel switches over SSH for the fc_fabric collector: every estate
// fc_switch gets its own SSH daemon (per-server host key) answering exec requests the way the switch CLI does.
// Brocade Fabric OS switches answer version, switchshow, chassisshow, fabricshow, nsshow, zoneshow and
// firmwareshow; Cisco MDS NX-OS switches answer show version, show wwn switch, show fcdomain domain-list, show fcns
// database detail, show zoneset active, show interface fc brief, show flogi database and show vsan. Commands of
// the other vendor fail as the real shell does, so the collector's probe-and-detect path runs. The effective zone
// configuration is the estate's zones of the switch's fabric (configuration name = the fabric name); every zone
// member WWN logs into the next free switch port (first member = host initiator, the rest = array targets) until
// the switch runs out of ports, and the rest stay zoned but absent from the name server, as on a full switch.
// Not in the estate and therefore fixed here: the MDS VSAN number (vsanID), HBA and array symbolic names and
// port speed.
package fcfabric

import (
	"context"
	"fmt"
	"strconv"
	"strings"

	"github.com/openmap/openmap/tools/simulator/internal/estate"
	"github.com/openmap/openmap/tools/simulator/internal/protocols/sshd"
	"github.com/openmap/openmap/tools/simulator/internal/sim"
)

const (
	vendorBrocade = "Brocade"
	vendorCisco   = "Cisco Systems"
	vsanID        = "20"
	hbaSymbol     = "QLE2772 FW:v9.12.01 DVR:v10.02.09.200-k"
	arraySymbol   = "PURE FlashArray"
	speedGbps     = 32
	// brocadeSwitchType is the FOS switchType of a G720.
	brocadeSwitchType = "173.0"
	exitNotFound      = 127
	exitInvalid       = 1
)

type Vendor struct{}

func (Vendor) ID() string             { return "fc-fabric" }
func (Vendor) Collector() string      { return "fc_fabric" }
func (Vendor) Requirements() []string { return []string{"REQ-DISC-015"} }

type login struct {
	pwwn   string
	target bool
	port   int // zero-based port index
}

type fcSwitch struct {
	ci      *estate.CI
	fabric  *estate.CI
	zones   []*estate.CI
	logins  []*login
	byWWN   map[string]*login
	ports   int
	domain  int
	server  *sshd.Server
	keyAuth bool
}

func (s *fcSwitch) brocade() bool { return s.ci.Str("manufacturer") == vendorBrocade }

func (s *fcSwitch) wwnn() string { return strings.ToLower(s.ci.ID("wwnn")) }

func load(e *estate.Estate, sw *estate.CI) *fcSwitch {
	s := &fcSwitch{ci: sw, byWWN: map[string]*login{}, ports: int(sw.Num("ports", 0)), domain: int(sw.Num("domainId", 1))}
	for _, f := range e.From(sw, "member_of") {
		if f.Type == "fc_fabric" {
			s.fabric = f
		}
	}
	if s.fabric == nil {
		return s
	}
	for _, z := range e.To(s.fabric, "member_of") {
		if z.Type != "fc_zone" {
			continue
		}
		s.zones = append(s.zones, z)
		for i, m := range z.Strs("members") {
			w := strings.ToLower(m)
			if _, ok := s.byWWN[w]; ok || len(s.logins) >= s.ports {
				continue
			}
			l := &login{pwwn: w, target: i > 0, port: len(s.logins)}
			s.logins = append(s.logins, l)
			s.byWWN[w] = l
		}
	}
	return s
}

func (s *fcSwitch) fcid(port int) string {
	return fmt.Sprintf("%02x%02x00", s.domain, port)
}

func nodeWWN(pwwn string, target bool) string {
	if target {
		return pwwn[:len(pwwn)-2] + "00"
	}
	return "20" + pwwn[2:]
}

func (s *fcSwitch) fabricPortWWN(port int) string {
	return fmt.Sprintf("20:%02x", port) + s.wwnn()[5:]
}

func (s *fcSwitch) loginAt(port int) *login {
	if port < len(s.logins) {
		return s.logins[port]
	}
	return nil
}

func symbolOf(l *login) string {
	if l.target {
		return arraySymbol
	}
	return hbaSymbol
}

func deviceTypeOf(l *login) string {
	if l.target {
		return "Physical Target"
	}
	return "Physical Initiator"
}

// --- Brocade Fabric OS ---

func (s *fcSwitch) fosVersion() string {
	return strings.TrimSpace(strings.TrimPrefix(s.ci.Str("firmware"), "FOS"))
}

func (s *fcSwitch) switchshow() string {
	var b strings.Builder
	cfg := s.fabric.Name
	fmt.Fprintf(&b, "switchName:\t%s\nswitchType:\t%s\nswitchState:\tOnline\nswitchMode:\tNative\nswitchRole:\tPrincipal\nswitchDomain:\t%d\nswitchId:\tfffc%02x\nswitchWwn:\t%s\nzoning:\t\tON (%s)\nswitchBeacon:\tOFF\nFC Router:\tOFF\nHIF Mode:\tOFF\nAllow XISL Use:\tOFF\nLS Attributes:\t[FID: 128, Base Switch: No, Default Switch: Yes, Ficon Switch: No, Address Mode 0]\n\n",
		s.ci.Name, brocadeSwitchType, s.domain, s.domain, s.wwnn(), cfg)
	b.WriteString("Index Port Address  Media Speed   State       Proto\n==================================================\n")
	for p := 0; p < s.ports; p++ {
		if l := s.loginAt(p); l != nil {
			fmt.Fprintf(&b, " %3d %3d   %s   id    N%d     Online      FC  F-Port  %s\n", p, p, s.fcid(p), speedGbps, l.pwwn)
		} else {
			fmt.Fprintf(&b, " %3d %3d   %s   id    N%d     No_Light    FC\n", p, p, s.fcid(p), speedGbps)
		}
	}
	return b.String()
}

func (s *fcSwitch) chassisshow() string {
	return "CHASSIS/WWN  Unit: 1\nHeader Version:\t\t2\nPower Consume Factor:\t-3\nFactory Part Num:\t40-1000574-01\nFactory Serial Num:\t" + s.ci.ID("serialNumber") +
		"\nManufacture:\t\tDay: 12  Month:  3  Year: 2023\nUpdate:\t\t\tDay:  2  Month: 10  Year: 2026\nTime Alive:\t\t1204 days\nTime Awake:\t\t96 days\n\nChassis Factory Serial Num:\t" + s.ci.ID("serialNumber") + "\n"
}

func (s *fcSwitch) fabricshow() string {
	return "Switch ID   Worldwide Name           Enet IP Addr    FC IP Addr      Name\n" +
		"-------------------------------------------------------------------------\n" +
		fmt.Sprintf("  %d: fffc%02x %s %-15s 0.0.0.0        >\"%s\"\n\nThe Fabric has 1 switch\n", s.domain, s.domain, s.wwnn(), s.server.Host, s.ci.Name)
}

func (s *fcSwitch) nsshow() string {
	var b strings.Builder
	b.WriteString("{\n Type Pid    COS     PortName                NodeName                 TTL(sec)\n")
	for _, l := range s.logins {
		sym := symbolOf(l)
		fmt.Fprintf(&b, " N    %s;      3;%s;%s; na\n    FC4s: FCP\n    PortSymb: [%d] \"%s\"\n    NodeSymb: [%d] \"%s\"\n    Fabric Port Name: %s\n    Permanent Port Name: %s\n    Device type: %s\n    Port Index: %d\n    Share Area: No\n    Device Shared in Other AD: No\n    Redirect: No\n    Partial: No\n    LSAN: No\n    Device link speed: %dG\n",
			s.fcid(l.port), l.pwwn, nodeWWN(l.pwwn, l.target), len(sym), sym, len(sym), sym, s.fabricPortWWN(l.port), l.pwwn, deviceTypeOf(l), l.port, speedGbps)
	}
	fmt.Fprintf(&b, "The Local Name Server has %d entries }\n", len(s.logins))
	return b.String()
}

func aliasOf(zone *estate.CI, i int) string {
	if i == 0 {
		return strings.TrimPrefix(zone.Name, "z_") + "_hba"
	}
	return zone.Str("array") + "_ct0_fc" + strconv.Itoa(i-1)
}

func (s *fcSwitch) zoneshow() string {
	var b strings.Builder
	cfg := s.fabric.Name
	names := make([]string, 0, len(s.zones))
	for _, z := range s.zones {
		names = append(names, z.Name)
	}
	b.WriteString("Defined configuration:\n cfg:\t" + cfg + "\t" + strings.Join(names, "; ") + "\n")
	aliases := map[string]string{}
	for _, z := range s.zones {
		members := z.Strs("members")
		parts := make([]string, 0, len(members))
		for i, m := range members {
			a := aliasOf(z, i)
			aliases[a] = strings.ToLower(m)
			parts = append(parts, a)
		}
		b.WriteString(" zone:\t" + z.Name + "\n\t\t" + strings.Join(parts, "; ") + "\n")
	}
	seen := map[string]bool{}
	for _, z := range s.zones {
		for i := range z.Strs("members") {
			a := aliasOf(z, i)
			if seen[a] {
				continue
			}
			seen[a] = true
			b.WriteString(" alias:\t" + a + "\n\t\t" + aliases[a] + "\n")
		}
	}
	b.WriteString("\nEffective configuration:\n cfg:\t" + cfg + "\n")
	for _, z := range s.zones {
		b.WriteString(" zone:\t" + z.Name + "\n")
		for _, m := range z.Strs("members") {
			b.WriteString("\t\t" + strings.ToLower(m) + "\n")
		}
	}
	return b.String()
}

func (s *fcSwitch) brocadeCommand(cmd string) (string, bool) {
	switch cmd {
	case "version":
		return "Kernel:     4.19.264\nFabric OS:  " + s.fosVersion() + "\nMade on:    Thu Jul 11 01:27:32 2024\nFlash:      Mon Jan 13 10:40:42 2025\nBootProm:   2.0.9\n", true
	case "switchshow":
		return s.switchshow(), true
	case "chassisshow":
		return s.chassisshow(), true
	case "fabricshow":
		return s.fabricshow(), true
	case "nsshow":
		return s.nsshow(), true
	case "zoneshow":
		return s.zoneshow(), true
	case "firmwareshow":
		return "Appl     Primary/Secondary Versions\n------------------------------------------\nFOS      " + s.fosVersion() + "\n         " + s.fosVersion() + "\n", true
	}
	return "", false
}

// --- Cisco MDS NX-OS ---

func (s *fcSwitch) nxosVersion() string {
	return strings.TrimSpace(strings.TrimPrefix(s.ci.Str("firmware"), "NX-OS"))
}

func (s *fcSwitch) mdsInterface(port int) string { return "fc1/" + strconv.Itoa(port+1) }

func (s *fcSwitch) showVersion() string {
	v := s.nxosVersion()
	file := strings.NewReplacer("(", ".", ")", "").Replace(v)
	return "Cisco Nexus Operating System (NX-OS) Software\nTAC support: http://www.cisco.com/tac\nCopyright (C) 2002-2025, Cisco and/or its affiliates.\nAll rights reserved.\n\n" +
		"Software\n  BIOS: version 1.12.0\n  system:    version " + v + "\n  BIOS compile time:   05/29/2023\n  system image file is:    bootflash:///m9148-s6ek9-mz." + file + ".bin\n  system compile time:     1/12/2025 4:00:00 [01/12/2025 13:35:12]\n\n" +
		"Hardware\n  cisco " + s.ci.Str("model") + " 32G 48 FC Ports Chassis (\"2/4/8/10/16/32 Gbps FC/Supervisor\")\n  Intel(R) Xeon(R) CPU D-1528 @ 1.90GHz with 8155968 kB of memory.\n  Processor Board ID " + s.ci.ID("serialNumber") +
		"\n\n  Device name: " + s.ci.Name + "\n  bootflash:    3915776 kB\n\nKernel uptime is 96 day(s), 4 hour(s), 12 minute(s), 9 second(s)\n"
}

func (s *fcSwitch) domainList() string {
	return "Number of domains: 1\nDomain ID              WWN\n---------    -----------------------\n" +
		fmt.Sprintf("0x%02x(%d)      %s [Local] [Principal]\n", s.domain, s.domain, strings.ToLower(s.fabric.ID("fabricWwn")))
}

func (s *fcSwitch) fcns() string {
	var b strings.Builder
	for _, l := range s.logins {
		vendor, fc4 := "Qlogic", "scsi-fcp:init"
		if l.target {
			vendor, fc4 = "Pure Storage", "scsi-fcp:target"
		}
		sym := symbolOf(l)
		fmt.Fprintf(&b, "------------------------\nVSAN:%s     FCID:0x%s\n------------------------\nport-wwn (vendor)           :%s (%s)\nnode-wwn                    :%s\nclass                       :3\nnode-ip-addr                :0.0.0.0\nipa                         :ff ff ff ff ff ff ff ff\nfc4-types:fc4_features      :%s\nsymbolic-port-name          :%s\nsymbolic-node-name          :%s\nport-type                   :N\nport-ip-addr                :0.0.0.0\nfabric-port-wwn             :%s\nhard-addr                   :0x000000\npermanent-port-wwn (vendor) :%s (%s)\nconnected interface         :%s\nswitch name (IP address)    :%s (%s)\n\n",
			vsanID, s.fcid(l.port), l.pwwn, vendor, nodeWWN(l.pwwn, l.target), fc4, sym, sym, s.fabricPortWWN(l.port), l.pwwn, vendor, s.mdsInterface(l.port), s.ci.Name, s.server.Host)
	}
	fmt.Fprintf(&b, "Total number of entries = %d\n", len(s.logins))
	return b.String()
}

func (s *fcSwitch) zonesetActive() string {
	var b strings.Builder
	b.WriteString("zoneset name " + s.fabric.Name + " vsan " + vsanID + "\n")
	for _, z := range s.zones {
		b.WriteString("  zone name " + z.Name + " vsan " + vsanID + "\n")
		for _, m := range z.Strs("members") {
			w := strings.ToLower(m)
			if l, ok := s.byWWN[w]; ok {
				b.WriteString("  * fcid 0x" + s.fcid(l.port) + " [pwwn " + w + "]\n")
			} else {
				b.WriteString("    pwwn " + w + "\n")
			}
		}
		b.WriteString("\n")
	}
	return b.String()
}

func (s *fcSwitch) interfaceBrief() string {
	var b strings.Builder
	b.WriteString("\n-------------------------------------------------------------------------------\nInterface  Vsan   Admin  Admin   Status          SFP    Oper  Oper   Port\n                  Mode   Trunk                          Mode  Speed  Channel\n                         Mode                                 (Gbps)\n-------------------------------------------------------------------------------\n")
	for p := 0; p < s.ports; p++ {
		if s.loginAt(p) != nil {
			fmt.Fprintf(&b, "%-10s %-6s auto   on      up               swl    F       %-5d  --\n", s.mdsInterface(p), vsanID, speedGbps)
		} else {
			fmt.Fprintf(&b, "%-10s %-6s auto   on      notConnected     swl    --      --     --\n", s.mdsInterface(p), vsanID)
		}
	}
	return b.String()
}

func (s *fcSwitch) flogi() string {
	var b strings.Builder
	b.WriteString("--------------------------------------------------------------------------------\nINTERFACE        VSAN    FCID           PORT NAME               NODE NAME\n--------------------------------------------------------------------------------\n")
	for _, l := range s.logins {
		fmt.Fprintf(&b, "%-16s %-7s 0x%s  %s %s\n", s.mdsInterface(l.port), vsanID, s.fcid(l.port), l.pwwn, nodeWWN(l.pwwn, l.target))
	}
	fmt.Fprintf(&b, "\nTotal number of flogi = %d.\n", len(s.logins))
	return b.String()
}

func (s *fcSwitch) mdsCommand(cmd string) (string, bool) {
	switch cmd {
	case "show version":
		return s.showVersion(), true
	case "show wwn switch":
		return "Switch WWN is " + s.wwnn() + "\n", true
	case "show fcdomain domain-list":
		return "VSAN " + vsanID + "\n" + s.domainList(), true
	case "show fcns database detail":
		return s.fcns(), true
	case "show zoneset active":
		return s.zonesetActive(), true
	case "show interface fc brief":
		return s.interfaceBrief(), true
	case "show flogi database":
		return s.flogi(), true
	case "show vsan":
		return "vsan 1 information\n         name:VSAN0001  state:active\n         interoperability mode:default\n         loadbalancing:src-id/dst-id/oxid\n         operational state:down\n\n" +
			"vsan " + vsanID + " information\n         name:" + s.fabric.Name + "  state:active\n         interoperability mode:default\n         loadbalancing:src-id/dst-id/oxid\n         operational state:up\n\nvsan 4079:evfp_isolated_vsan\n\nvsan 4094:isolated_vsan\n", true
	}
	return "", false
}

func (s *fcSwitch) handle(r sshd.Request) sshd.Reply {
	cmd := strings.TrimSpace(r.Command)
	if s.brocade() {
		if out, ok := s.brocadeCommand(cmd); ok {
			return sshd.Reply{Stdout: out}
		}
		word := strings.Fields(cmd + " -")[0]
		return sshd.Reply{Stderr: "rbash: " + word + ": command not found\n", Status: exitNotFound}
	}
	if out, ok := s.mdsCommand(cmd); ok {
		return sshd.Reply{Stdout: out}
	}
	return sshd.Reply{Stderr: "                      ^\n% Invalid command at '^' marker.\n", Status: exitInvalid}
}

func switches(e *estate.Estate) []*fcSwitch {
	var out []*fcSwitch
	for _, sw := range e.OfType("fc_switch", func(c *estate.CI) bool {
		m := c.Str("manufacturer")
		return m == vendorBrocade || m == vendorCisco
	}) {
		if s := load(e, sw); s.fabric != nil {
			out = append(out, s)
		}
	}
	return out
}

func (Vendor) Start(_ context.Context, e *estate.Estate, env *sim.Env) (*sim.Endpoint, error) {
	privPEM, pub, err := sshd.ClientKey()
	if err != nil {
		return nil, err
	}
	all := switches(e)
	ep := &sim.Endpoint{Host: sim.AdvertiseHost(), State: map[string]any{"switches": all, "clientKey": privPEM}}
	for _, s := range all {
		srv, err := sshd.Serve(env, s.handle, sshd.Config{AuthorizedKey: pub})
		if err != nil {
			_ = ep.Close()
			return nil, err
		}
		s.server = srv
		s.keyAuth = s.brocade()
		ep.OnClose(srv.Close)
	}
	return ep, nil
}

func (Vendor) Runs(_ *estate.Estate, ep *sim.Endpoint, env *sim.Env) []sim.Run {
	all, _ := ep.State["switches"].([]*fcSwitch)
	privPEM, _ := ep.State["clientKey"].(string)
	var runs []sim.Run
	for _, s := range all {
		cred := sshd.PasswordCredential(env)
		if s.keyAuth {
			cred = sshd.KeyCredential(env, privPEM)
		}
		run := sim.Run{Name: s.ci.Name, Targets: []sim.Target{s.server.Target(s.ci.Name)}, Options: s.server.Options(), CredentialType: cred.Type, Credential: cred}
		x := &run.Expect
		x.EstateCI(s.ci)
		fabricName := s.ci.Name + " VSAN " + vsanID
		if s.brocade() {
			fabricName = "Fabric " + s.fabric.Name
		}
		x.CIs = append(x.CIs, sim.ExpectCI{Type: "fc_fabric", Name: fabricName, Identity: s.fabric.Identity})
		x.Rel("member_of", "fc_switch", s.ci.Name, "fc_fabric", fabricName)
		for _, z := range s.zones {
			x.EstateCI(z)
			x.Rel("member_of", "fc_zone", z.Name, "fc_fabric", fabricName)
		}
		for p := 0; p < s.ports; p++ {
			name := "port" + strconv.Itoa(p)
			if !s.brocade() {
				name = s.mdsInterface(p)
			}
			x.CI("port", name)
			x.Rel("contains", "fc_switch", s.ci.Name, "port", name)
		}
		runs = append(runs, run)
	}
	return runs
}
