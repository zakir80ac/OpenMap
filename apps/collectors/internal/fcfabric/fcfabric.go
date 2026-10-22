// REQ-DISC-015 — Fibre Channel fabric collector over SSH CLI: Brocade Fabric OS and Cisco MDS
// NX-OS switches. Emits the fc_switch, the fc_fabric it belongs to (principal switch WWN, per
// VSAN on MDS), every fc_zone of the effective configuration with resolved member WWNs, and the
// switch ports with the name-server view of what is logged in (initiator or target, symbolic names).
package fcfabric

import (
	"context"
	"sort"
	"strings"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/collector"
	"github.com/openmap/openmap/apps/collectors/internal/contract"
	"github.com/openmap/openmap/apps/collectors/internal/sshexec"
)

const (
	collectorID  = "fc_fabric"
	version      = "0.1.0"
	evidenceKind = "cli_output"
	optionVendor = "vendor" // brocade | cisco_mds; detected from `version` when absent

	typeSwitch = "fc_switch"
	typeFabric = "fc_fabric"
	typeZone   = "fc_zone"
	typePort   = "port"
	relMember  = "member_of"
	relContain = "contains"
)

type Collector struct{}

func (Collector) Manifest() contract.Manifest {
	return contract.Manifest{
		ID: collectorID, Family: "fc_fabric", Version: version, Language: "go",
		Protocols: []string{"ssh"}, CredentialTypes: []string{"password", "ssh_key"},
		TargetKinds: []string{"host"}, Emits: []string{typeSwitch, typeFabric, typeZone, typePort},
		ContractVersion: contract.Version,
	}
}

// Switch is the vendor-neutral view both parsers fill.
type Switch struct {
	Vendor          string
	Name            string
	Model           string
	Serial          string
	Firmware        string
	WWNN            string
	Domain          string
	Role            string
	State           string
	Zoning          string
	FabricWWN       string
	VsanFabrics     map[string]string // MDS: vsan → principal WWN
	Fabric          []FabricMember
	Ports           map[string]*Port
	NameServer      []*NameServerEntry
	Zones           []*Zone
	Aliases         map[string][]string
	EffectiveConfig string
}

type FabricMember struct {
	Domain    string
	WWNN      string
	MgmtIP    string
	Name      string
	Vsan      string
	Principal bool
}

type Port struct {
	Name        string
	Index       int
	Address     string
	Media       string
	Speed       string
	State       string
	Protocol    string
	PortType    string
	Vsan        string
	AttachedWWN string
}

type NameServerEntry struct {
	Type       string
	FCID       string
	PWWN       string
	NWWN       string
	PortSymbol string
	NodeSymbol string
	DeviceType string
	Vendor     string
	FC4        string
	PortIndex  string
	Vsan       string
}

type Zone struct {
	Name       string
	Config     string
	Vsan       string
	Members    []string
	MemberWWNs []string
}

// Detect picks the parser from the `version` output when the job did not name the vendor.
func Detect(outputs map[string]string, hint string) string {
	switch strings.ToLower(hint) {
	case "brocade", "cisco_mds":
		return strings.ToLower(hint)
	}
	v := outputs["version"] + outputs["show version"]
	switch {
	case strings.Contains(v, "Fabric OS"):
		return "brocade"
	case strings.Contains(v, "NX-OS") || strings.Contains(v, "Nexus") || strings.Contains(v, "MDS"):
		return "cisco_mds"
	default:
		return ""
	}
}

// Emit converts a switch view into observations.
func Emit(sw *Switch, outputs map[string]string, target contract.Target, hostKey string, at time.Time) collector.Observation {
	obs := collector.Observation{}
	keys := make([]string, 0, len(outputs))
	for k := range outputs {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		obs.Evidence = append(obs.Evidence, collector.RawEvidence{Kind: evidenceKind, Data: []byte("$ " + k + "\n" + outputs[k])})
	}
	wwnn := strings.ToLower(sw.WWNN)
	switchIdentity := map[string]string{"wwnn": wwnn}
	if sw.Serial != "" {
		switchIdentity["serialNumber"] = sw.Serial
	}
	switchRef := contract.CiRef{Type: typeSwitch, Identity: switchIdentity}
	nsByPWWN := map[string]*NameServerEntry{}
	initiators, targets := 0, 0
	for _, e := range sw.NameServer {
		nsByPWWN[e.PWWN] = e
		switch {
		case strings.Contains(strings.ToLower(e.DeviceType), "initiator"):
			initiators++
		case strings.Contains(strings.ToLower(e.DeviceType), "target"):
			targets++
		}
	}
	online := 0
	for _, p := range sw.Ports {
		if strings.EqualFold(p.State, "Online") || strings.EqualFold(p.State, "up") {
			online++
		}
	}
	attrs := map[string]any{"vendor": sw.Vendor, "model": sw.Model, "firmware": sw.Firmware, "domain": sw.Domain, "role": sw.Role, "state": sw.State, "zoning": sw.Zoning, "effectiveConfig": sw.EffectiveConfig,
		"portCount": len(sw.Ports), "portsOnline": online, "nameServerEntries": len(sw.NameServer), "initiators": initiators, "targets": targets, "zoneCount": len(sw.Zones), "managementIp": target.Value, "fabricWwn": sw.FabricWWN}
	if hostKey != "" {
		attrs["sshHostKeySha256"] = hostKey
	}
	obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeSwitch, Identity: switchIdentity, Name: firstNonEmpty(sw.Name, target.Value), Attributes: attrs, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})

	fabricRefs := map[string]contract.CiRef{}
	emitFabric := func(fabricWwn, label, vsan string) contract.CiRef {
		if ref, ok := fabricRefs[fabricWwn]; ok {
			return ref
		}
		identity := map[string]string{"fabricWwn": fabricWwn}
		ref := contract.CiRef{Type: typeFabric, Identity: identity}
		fabricRefs[fabricWwn] = ref
		members := []map[string]any{}
		for _, m := range sw.Fabric {
			if vsan == "" || m.Vsan == vsan {
				members = append(members, map[string]any{"domain": m.Domain, "wwnn": m.WWNN, "name": m.Name, "managementIp": m.MgmtIP, "principal": m.Principal})
			}
		}
		fattrs := map[string]any{"vendor": sw.Vendor, "principalWwn": fabricWwn, "switches": members, "switchCount": len(members), "effectiveConfig": sw.EffectiveConfig}
		if vsan != "" {
			fattrs["vsan"] = vsan
		}
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeFabric, Identity: identity, Name: label, Attributes: fattrs, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
		obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relMember, From: switchRef, To: ref, Attributes: map[string]any{"domain": sw.Domain}, ObservedAt: at})
		return ref
	}
	if len(sw.VsanFabrics) > 0 {
		vsans := make([]string, 0, len(sw.VsanFabrics))
		for v := range sw.VsanFabrics {
			vsans = append(vsans, v)
		}
		sort.Strings(vsans)
		for _, v := range vsans {
			emitFabric(sw.VsanFabrics[v], firstNonEmpty(sw.Name, target.Value)+" VSAN "+v, v)
		}
	} else if sw.FabricWWN != "" {
		emitFabric(sw.FabricWWN, "Fabric "+firstNonEmpty(sw.EffectiveConfig, sw.FabricWWN), "")
	}

	for _, z := range sw.Zones {
		fabricWwn := sw.FabricWWN
		if z.Vsan != "" {
			if w, ok := sw.VsanFabrics[z.Vsan]; ok {
				fabricWwn = w
			}
		}
		if fabricWwn == "" {
			fabricWwn = wwnn
		}
		fabricRef := emitFabric(fabricWwn, "Fabric "+fabricWwn, z.Vsan)
		identity := map[string]string{"fabricRef": fabricWwn, "name": z.Name}
		memberDetail := []map[string]any{}
		for _, w := range z.MemberWWNs {
			d := map[string]any{"pwwn": w}
			if e, ok := nsByPWWN[w]; ok {
				d["deviceType"], d["portSymbol"], d["nodeSymbol"], d["vendor"] = e.DeviceType, e.PortSymbol, e.NodeSymbol, e.Vendor
			}
			memberDetail = append(memberDetail, d)
		}
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeZone, Identity: identity, Name: z.Name,
			Attributes: map[string]any{"config": z.Config, "vsan": z.Vsan, "members": z.Members, "memberWwns": z.MemberWWNs, "memberDetail": memberDetail, "memberCount": len(z.Members)},
			Tags:       []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
		obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relMember, From: contract.CiRef{Type: typeZone, Identity: identity}, To: fabricRef, Attributes: map[string]any{}, ObservedAt: at})
	}

	names := make([]string, 0, len(sw.Ports))
	for n := range sw.Ports {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		p := sw.Ports[n]
		identity := map[string]string{"deviceRef": wwnn, "name": p.Name}
		pattrs := map[string]any{"index": p.Index, "fcid": p.Address, "media": p.Media, "speed": p.Speed, "state": p.State, "protocol": p.Protocol, "portType": p.PortType, "vsan": p.Vsan, "attachedPwwn": p.AttachedWWN}
		if e, ok := nsByPWWN[p.AttachedWWN]; ok {
			pattrs["attachedDeviceType"], pattrs["attachedPortSymbol"], pattrs["attachedNodeSymbol"], pattrs["attachedVendor"], pattrs["attachedNwwn"] = e.DeviceType, e.PortSymbol, e.NodeSymbol, e.Vendor, e.NWWN
		}
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typePort, Identity: identity, Name: p.Name, Attributes: pattrs, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
		obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relContain, From: switchRef, To: contract.CiRef{Type: typePort, Identity: identity}, Attributes: map[string]any{}, ObservedAt: at})
	}
	return obs
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

func (Collector) Collect(ctx context.Context, target contract.Target, cred *contract.Credential, options map[string]any) (collector.Observation, error) {
	hint, _ := options[optionVendor].(string)
	probe := []string{"version", "show version"}
	commands := probe
	switch strings.ToLower(hint) {
	case "brocade":
		commands = BrocadeCommands
	case "cisco_mds":
		commands = MdsCommands
	}
	outputs, hostKey, err := sshexec.Exec(ctx, target, cred, options, commands)
	if err != nil {
		return collector.Observation{}, err
	}
	vendor := Detect(outputs, hint)
	if vendor == "" {
		return collector.Observation{}, collector.Errorf(contract.ErrUnsupportedDevice, false, "%s is neither Brocade FOS nor Cisco MDS", target.Value)
	}
	if strings.ToLower(hint) != vendor {
		// Probed without a hint: fetch the vendor's full command set now.
		full := BrocadeCommands
		if vendor == "cisco_mds" {
			full = MdsCommands
		}
		outputs, hostKey, err = sshexec.Exec(ctx, target, cred, options, full)
		if err != nil {
			return collector.Observation{}, err
		}
	}
	var sw *Switch
	if vendor == "brocade" {
		sw = ParseBrocade(outputs)
	} else {
		sw = ParseMds(outputs)
	}
	if sw.WWNN == "" {
		return collector.Observation{}, collector.Errorf(contract.ErrParse, false, "%s: could not read the switch WWN", target.Value)
	}
	return Emit(sw, outputs, target, hostKey, time.Now().UTC()), nil
}
