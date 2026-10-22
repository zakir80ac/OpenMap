// REQ-DISC-015 — Cisco MDS NX-OS parsers: show version, show wwn switch, show fcdomain
// domain-list, show fcns database, show zoneset active, show interface fc brief, show flogi database.
package fcfabric

import (
	"regexp"
	"strings"
)

// MdsCommands are the read-only NX-OS commands the collector runs.
var MdsCommands = []string{"show version", "show wwn switch", "show fcdomain domain-list", "show fcns database detail", "show zoneset active", "show interface fc brief", "show flogi database", "show vsan"}

var (
	mdsVsanHeader   = regexp.MustCompile(`^VSAN\s+(\d+)`)
	mdsDomainLine   = regexp.MustCompile(`^\s*0x[0-9a-f]+\((\d+)\)\s+([0-9a-f:]{23})\s*(\[Principal\]|\[Local\])*`)
	mdsFcnsEntry    = regexp.MustCompile(`^\s*0x([0-9a-f]{6})\s+([NL]+)\s+([0-9a-f:]{23})\s*(\(([^)]*)\))?\s*(\S*)`)
	mdsFcnsDetail   = regexp.MustCompile(`^\s*(port-wwn \(vendor\)|node-wwn|class|node-ip-addr|ipa|fc4-types:fc4_features|symbolic-port-name|symbolic-node-name|port-type|port-ip-addr|fabric-port-wwn|hard-addr|permanent-port-wwn \(vendor\)|connected interface|switch name \(IP address\))\s*:\s*(.*)$`)
	mdsZonesetLine  = regexp.MustCompile(`^zoneset name (\S+) vsan (\d+)`)
	mdsZoneLine     = regexp.MustCompile(`^\s+zone name (\S+) vsan (\d+)`)
	mdsZoneMember   = regexp.MustCompile(`^\s+\*?\s*(fcid 0x[0-9a-f]+|pwwn|device-alias|fwwn|interface)\s*([^\[\]]*)?(\[pwwn ([0-9a-f:]{23})\])?(\[device-alias ([^\]]+)\])?`)
	mdsFlogiLine    = regexp.MustCompile(`^(fc\d+/\d+|port-channel\d+)\s+(\d+)\s+0x([0-9a-f]{6})\s+([0-9a-f:]{23})\s+([0-9a-f:]{23})`)
	mdsVersionLine  = regexp.MustCompile(`^\s*(system|NXOS|kickstart):\s+version\s+(\S+)`)
	mdsBoardLine    = regexp.MustCompile(`Processor Board ID\s+(\S+)`)
	mdsChassisLine  = regexp.MustCompile(`^\s*cisco (MDS \S+)`)
	mdsSwitchWwn    = regexp.MustCompile(`Switch WWN is ([0-9a-f:]{23})`)
	mdsHostnameLine = regexp.MustCompile(`Device name:\s+(\S+)`)
)

// ParseMds reads NX-OS outputs into a Switch view. VSANs become fabrics; the principal domain
// WWN of each VSAN is its fabric identity.
func ParseMds(outputs map[string]string) *Switch {
	sw := &Switch{Vendor: "cisco_mds", Ports: map[string]*Port{}, Aliases: map[string][]string{}, VsanFabrics: map[string]string{}}
	parseMdsVersion(outputs["show version"], sw)
	if m := mdsSwitchWwn.FindStringSubmatch(outputs["show wwn switch"]); m != nil {
		sw.WWNN = strings.ToLower(m[1])
	}
	parseMdsDomains(outputs["show fcdomain domain-list"], sw)
	parseMdsInterfaces(outputs["show interface fc brief"], sw)
	parseMdsFlogi(outputs["show flogi database"], sw)
	parseMdsFcns(outputs["show fcns database detail"], sw)
	parseMdsZoneset(outputs["show zoneset active"], sw)
	if sw.FabricWWN == "" {
		for _, w := range sw.VsanFabrics {
			sw.FabricWWN = w
			break
		}
	}
	return sw
}

func parseMdsVersion(text string, sw *Switch) {
	for _, line := range strings.Split(text, "\n") {
		if m := mdsVersionLine.FindStringSubmatch(line); m != nil && sw.Firmware == "" {
			sw.Firmware = "NX-OS " + m[2]
		}
		if m := mdsBoardLine.FindStringSubmatch(line); m != nil {
			sw.Serial = m[1]
		}
		if m := mdsChassisLine.FindStringSubmatch(line); m != nil && sw.Model == "" {
			sw.Model = m[1]
		}
		if m := mdsHostnameLine.FindStringSubmatch(line); m != nil {
			sw.Name = m[1]
		}
	}
	sw.State = "Online"
}

func parseMdsDomains(text string, sw *Switch) {
	vsan := ""
	for _, line := range strings.Split(text, "\n") {
		if m := mdsVsanHeader.FindStringSubmatch(strings.TrimSpace(line)); m != nil {
			vsan = m[1]
			continue
		}
		m := mdsDomainLine.FindStringSubmatch(line)
		if m == nil || vsan == "" {
			continue
		}
		member := FabricMember{Domain: m[1], WWNN: strings.ToLower(m[2]), Vsan: vsan, Principal: strings.Contains(line, "[Principal]")}
		if strings.Contains(line, "[Local]") {
			member.Name = sw.Name
			sw.Domain = m[1]
		}
		sw.Fabric = append(sw.Fabric, member)
		if member.Principal {
			sw.VsanFabrics[vsan] = member.WWNN
		}
	}
}

func parseMdsInterfaces(text string, sw *Switch) {
	for _, line := range strings.Split(text, "\n") {
		f := strings.Fields(line)
		if len(f) < 7 || !strings.HasPrefix(f[0], "fc") || !strings.Contains(f[0], "/") {
			continue
		}
		p := &Port{Name: f[0], Vsan: f[1], State: f[4], Media: f[5], PortType: f[6], Protocol: "FC"}
		if len(f) > 8 && f[7] != "--" {
			p.Speed = f[7]
		}
		sw.Ports[f[0]] = p
	}
}

func parseMdsFlogi(text string, sw *Switch) {
	for _, line := range strings.Split(text, "\n") {
		m := mdsFlogiLine.FindStringSubmatch(strings.TrimSpace(line))
		if m == nil {
			continue
		}
		p, ok := sw.Ports[m[1]]
		if !ok {
			p = &Port{Name: m[1], Vsan: m[2], Protocol: "FC"}
			sw.Ports[m[1]] = p
		}
		p.Address = m[3]
		p.AttachedWWN = strings.ToLower(m[4])
	}
}

func parseMdsFcns(text string, sw *Switch) {
	var cur *NameServerEntry
	vsan := ""
	for _, line := range strings.Split(text, "\n") {
		t := strings.TrimSpace(line)
		if m := mdsVsanHeader.FindStringSubmatch(t); m != nil {
			vsan = m[1]
			continue
		}
		if m := mdsFcnsEntry.FindStringSubmatch(line); m != nil {
			cur = &NameServerEntry{Type: m[2], FCID: m[1], PWWN: strings.ToLower(m[3]), Vendor: m[5], FC4: m[6], Vsan: vsan}
			sw.NameServer = append(sw.NameServer, cur)
			continue
		}
		if cur == nil {
			continue
		}
		if m := mdsFcnsDetail.FindStringSubmatch(t); m != nil {
			v := strings.TrimSpace(m[2])
			switch m[1] {
			case "port-wwn (vendor)":
				if w := wwnPattern.FindString(strings.ToLower(v)); w != "" {
					cur.PWWN = w
				}
				if i := strings.Index(v, "("); i >= 0 && strings.HasSuffix(v, ")") {
					cur.Vendor = v[i+1 : len(v)-1]
				}
			case "node-wwn":
				cur.NWWN = strings.ToLower(v)
			case "symbolic-port-name":
				cur.PortSymbol = v
			case "symbolic-node-name":
				cur.NodeSymbol = v
			case "fc4-types:fc4_features":
				cur.FC4 = v
				cur.DeviceType = deviceTypeOf(v)
			case "connected interface":
				cur.PortIndex = v
			}
		}
	}
}

func deviceTypeOf(fc4 string) string {
	f := strings.ToLower(fc4)
	switch {
	case strings.Contains(f, "target") && strings.Contains(f, "init"):
		return "Physical Initiator+Target"
	case strings.Contains(f, "target"):
		return "Physical Target"
	case strings.Contains(f, "init"):
		return "Physical Initiator"
	default:
		return ""
	}
}

func parseMdsZoneset(text string, sw *Switch) {
	var current *Zone
	for _, line := range strings.Split(text, "\n") {
		t := strings.TrimRight(line, "\r")
		if m := mdsZonesetLine.FindStringSubmatch(strings.TrimSpace(t)); m != nil {
			sw.EffectiveConfig = m[1]
			current = nil
			continue
		}
		if m := mdsZoneLine.FindStringSubmatch(t); m != nil {
			current = &Zone{Name: m[1], Vsan: m[2], Config: sw.EffectiveConfig}
			sw.Zones = append(sw.Zones, current)
			continue
		}
		if current == nil {
			continue
		}
		trimmed := strings.TrimSpace(t)
		if trimmed == "" {
			continue
		}
		member := strings.TrimPrefix(trimmed, "* ")
		current.Members = append(current.Members, member)
		for _, w := range wwnPattern.FindAllString(strings.ToLower(member), -1) {
			if !strings.Contains(member, "fwwn "+w) {
				current.MemberWWNs = append(current.MemberWWNs, w)
			}
		}
		if i := strings.Index(member, "device-alias "); i >= 0 {
			alias := strings.Trim(member[i+len("device-alias "):], "[] ")
			if w := wwnPattern.FindString(strings.ToLower(member)); w != "" && alias != "" {
				sw.Aliases[alias] = []string{w}
			}
		}
	}
}
