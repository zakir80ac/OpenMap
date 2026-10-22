// REQ-DISC-015 — Brocade Fabric OS parsers: switchshow, chassisshow, fabricshow, nsshow,
// zoneshow (effective configuration with alias resolution) and version.
package fcfabric

import (
	"regexp"
	"strconv"
	"strings"
)

// BrocadeCommands are the read-only FOS commands the collector runs.
var BrocadeCommands = []string{"version", "switchshow", "chassisshow", "fabricshow", "nsshow", "zoneshow", "firmwareshow"}

var (
	brocadeKV       = regexp.MustCompile(`^(\w[\w ]*?):\s+(.*)$`)
	brocadePortLine = regexp.MustCompile(`^\s*(\d+)\s+(\d+)\s+([0-9a-f]{6})\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s*(.*)$`)
	brocadeFabric   = regexp.MustCompile(`^\s*(\d+):\s+([0-9a-f]{6})\s+([0-9a-f:]{23})\s+(\S+)\s+(\S+)\s+(>?)"?([^"]*)"?`)
	brocadeNsEntry  = regexp.MustCompile(`^\s*([NL]+)\s+([0-9a-f]{6});\s*(\d+);\s*([0-9a-f:]{23});\s*([0-9a-f:]{23});`)
	wwnPattern      = regexp.MustCompile(`([0-9a-f]{2}:){7}[0-9a-f]{2}`)
)

// ParseBrocade reads all FOS outputs into a Fabric view.
func ParseBrocade(outputs map[string]string) *Switch {
	sw := &Switch{Vendor: "brocade", Ports: map[string]*Port{}, Aliases: map[string][]string{}}
	parseBrocadeVersion(outputs["version"], sw)
	parseSwitchshow(outputs["switchshow"], sw)
	parseChassisshow(outputs["chassisshow"], sw)
	parseFabricshow(outputs["fabricshow"], sw)
	parseNsshow(outputs["nsshow"], sw)
	parseZoneshow(outputs["zoneshow"], sw)
	return sw
}

func parseBrocadeVersion(text string, sw *Switch) {
	for _, line := range strings.Split(text, "\n") {
		if m := brocadeKV.FindStringSubmatch(strings.TrimSpace(line)); m != nil && strings.EqualFold(m[1], "Fabric OS") {
			sw.Firmware = strings.TrimSpace(m[2])
		}
	}
}

func parseSwitchshow(text string, sw *Switch) {
	inPorts := false
	for _, line := range strings.Split(text, "\n") {
		t := strings.TrimRight(line, "\r")
		if !inPorts {
			if strings.HasPrefix(strings.TrimSpace(t), "Index") || strings.HasPrefix(strings.TrimSpace(t), "Port") && strings.Contains(t, "Media") {
				inPorts = true
				continue
			}
			if strings.HasPrefix(strings.TrimSpace(t), "===") {
				inPorts = true
				continue
			}
			if m := brocadeKV.FindStringSubmatch(strings.TrimSpace(t)); m != nil {
				v := strings.TrimSpace(m[2])
				switch strings.ToLower(m[1]) {
				case "switchname":
					sw.Name = v
				case "switchtype":
					sw.Model = v
				case "switchstate":
					sw.State = v
				case "switchrole":
					sw.Role = v
				case "switchdomain":
					sw.Domain = v
				case "switchwwn":
					sw.WWNN = strings.ToLower(v)
				case "zoning":
					sw.Zoning = v
				}
			}
			continue
		}
		m := brocadePortLine.FindStringSubmatch(t)
		if m == nil {
			continue
		}
		name := "port" + m[2]
		p := &Port{Name: name, Index: atoi(m[1]), Address: m[3], Media: m[4], Speed: m[5], State: m[6], Protocol: m[7]}
		rest := strings.Fields(m[8])
		if len(rest) > 0 {
			p.PortType = rest[0]
		}
		if w := wwnPattern.FindString(strings.ToLower(m[8])); w != "" {
			p.AttachedWWN = strings.ToLower(w)
		}
		sw.Ports[name] = p
	}
}

func parseChassisshow(text string, sw *Switch) {
	for _, line := range strings.Split(text, "\n") {
		t := strings.TrimSpace(line)
		switch {
		case strings.HasPrefix(t, "Serial Num:") && sw.Serial == "":
			sw.Serial = strings.TrimSpace(strings.TrimPrefix(t, "Serial Num:"))
		case strings.HasPrefix(t, "Chassis Factory Serial Num:"):
			sw.Serial = strings.TrimSpace(strings.TrimPrefix(t, "Chassis Factory Serial Num:"))
		case strings.HasPrefix(t, "Chassis Family:"):
			if sw.Model == "" {
				sw.Model = strings.TrimSpace(strings.TrimPrefix(t, "Chassis Family:"))
			}
		}
	}
}

func parseFabricshow(text string, sw *Switch) {
	for _, line := range strings.Split(text, "\n") {
		m := brocadeFabric.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		member := FabricMember{Domain: m[1], WWNN: strings.ToLower(m[3]), MgmtIP: m[4], Name: strings.TrimSpace(m[7]), Principal: m[6] == ">"}
		sw.Fabric = append(sw.Fabric, member)
		if member.Principal {
			sw.FabricWWN = member.WWNN
		}
	}
	if sw.FabricWWN == "" && len(sw.Fabric) > 0 {
		sw.FabricWWN = sw.Fabric[0].WWNN
	}
}

func parseNsshow(text string, sw *Switch) {
	var cur *NameServerEntry
	for _, line := range strings.Split(text, "\n") {
		t := strings.TrimSpace(line)
		if m := brocadeNsEntry.FindStringSubmatch(line); m != nil {
			cur = &NameServerEntry{Type: m[1], FCID: m[2], PWWN: strings.ToLower(m[4]), NWWN: strings.ToLower(m[5])}
			sw.NameServer = append(sw.NameServer, cur)
			continue
		}
		if cur == nil {
			continue
		}
		switch {
		case strings.HasPrefix(t, "PortSymb:"):
			cur.PortSymbol = symbol(strings.TrimPrefix(t, "PortSymb:"))
		case strings.HasPrefix(t, "NodeSymb:"):
			cur.NodeSymbol = symbol(strings.TrimPrefix(t, "NodeSymb:"))
		case strings.HasPrefix(t, "Device type:"):
			cur.DeviceType = strings.TrimSpace(strings.TrimPrefix(t, "Device type:"))
		case strings.HasPrefix(t, "Port Index:"):
			cur.PortIndex = strings.TrimSpace(strings.TrimPrefix(t, "Port Index:"))
		}
	}
}

func parseZoneshow(text string, sw *Switch) {
	section := ""
	var current *Zone
	var cfgName string
	flushMembers := func(target *[]string, s string) {
		for _, part := range strings.Split(s, ";") {
			if p := strings.TrimSpace(part); p != "" {
				*target = append(*target, p)
			}
		}
	}
	for _, line := range strings.Split(text, "\n") {
		t := strings.TrimRight(line, "\r")
		trimmed := strings.TrimSpace(t)
		switch {
		case strings.HasPrefix(trimmed, "Defined configuration:"):
			section = "defined"
			current = nil
			continue
		case strings.HasPrefix(trimmed, "Effective configuration:"):
			section = "effective"
			current = nil
			continue
		}
		if trimmed == "" {
			continue
		}
		fields := strings.Fields(trimmed)
		switch {
		case strings.HasPrefix(trimmed, "cfg:"):
			current = nil
			if len(fields) > 1 {
				cfgName = fields[1]
				if section == "effective" {
					sw.EffectiveConfig = cfgName
				}
			}
		case strings.HasPrefix(trimmed, "zone:"):
			if len(fields) < 2 {
				continue
			}
			z := &Zone{Name: fields[1], Config: cfgName}
			if section == "effective" {
				sw.Zones = append(sw.Zones, z)
				current = z
			} else {
				current = nil
			}
			if len(fields) > 2 {
				flushMembers(&z.Members, strings.Join(fields[2:], " "))
			}
		case strings.HasPrefix(trimmed, "alias:"):
			current = nil
			if len(fields) >= 3 {
				var members []string
				flushMembers(&members, strings.Join(fields[2:], " "))
				sw.Aliases[fields[1]] = members
			}
		default:
			if current != nil && section == "effective" {
				flushMembers(&current.Members, trimmed)
			}
		}
	}
	// Resolve aliases to WWNs where the defined configuration named them.
	for _, z := range sw.Zones {
		for _, m := range z.Members {
			if w := strings.ToLower(m); wwnPattern.MatchString(w) {
				z.MemberWWNs = append(z.MemberWWNs, w)
			} else if wwns, ok := sw.Aliases[m]; ok {
				for _, w := range wwns {
					if wwnPattern.MatchString(strings.ToLower(w)) {
						z.MemberWWNs = append(z.MemberWWNs, strings.ToLower(w))
					}
				}
			}
		}
	}
}

var symbolPrefix = regexp.MustCompile(`^\s*\[\d+\]\s*`)

// symbol strips the FOS `[length] "text"` wrapper around symbolic names.
func symbol(s string) string {
	return strings.Trim(strings.TrimSpace(symbolPrefix.ReplaceAllString(s, "")), `"`)
}

func atoi(s string) int {
	n, _ := strconv.Atoi(s)
	return n
}
