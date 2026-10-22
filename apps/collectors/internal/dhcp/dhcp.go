// REQ-DISC-022 REQ-IPAM-002 — DHCP collector: Windows DHCP Server (PowerShell over WinRM), ISC
// dhcpd (dhcpd.conf and dhcpd.leases over SSH) and Kea (kea-dhcp4.conf and the lease CSV over
// SSH). Emits dhcp_scope, dhcp_lease and ip_address CIs, with leased_to pointing at the host that
// owns the MAC so leases join the hosts other collectors found.
package dhcp

import (
	"context"
	"encoding/json"
	"net"
	"strconv"
	"strings"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/collector"
	"github.com/openmap/openmap/apps/collectors/internal/contract"
	"github.com/openmap/openmap/apps/collectors/internal/sshexec"
	"github.com/openmap/openmap/apps/collectors/internal/winrmexec"
)

const (
	collectorID  = "dhcp"
	version      = "0.1.0"
	evidenceKind = "cli_output"
	optionMode   = "mode" // windows | isc | kea
	modeWindows  = "windows"
	modeISC      = "isc"
	modeKea      = "kea"
	optionLeases = "leasesPath"
	optionConfig = "configPath"
	defaultVrf   = "default"
	ipv4Bits     = 32

	typeScope   = "dhcp_scope"
	typeLease   = "dhcp_lease"
	typeIP      = "ip_address"
	typeHost    = "host"
	relContains = "contains"
	relLeasedTo = "leased_to"
	relInSubnet = "in_subnet"
	typeSubnet  = "subnet"
)

type Collector struct{}

func (Collector) Manifest() contract.Manifest {
	return contract.Manifest{
		ID: collectorID, Family: "dhcp", Version: version, Language: "go",
		Protocols: []string{"winrm", "ssh"}, CredentialTypes: []string{"password", "ssh_key"},
		TargetKinds: []string{"host"}, Emits: []string{typeScope, typeLease, typeIP},
		ContractVersion: contract.Version,
	}
}

// Scope is one DHCP range.
type Scope struct {
	Name     string
	CIDR     string
	Start    string
	End      string
	Router   string
	DNS      []string
	LeaseTTL string
	State    string
}

// Lease is one active binding.
type Lease struct {
	Address   string
	MAC       string
	Hostname  string
	Expires   string
	State     string
	ScopeCIDR string
	Static    bool
}

// WindowsScript lists scopes, leases and reservations as one JSON document.
const WindowsScript = `
$ErrorActionPreference = 'SilentlyContinue'
$scopes = @(Get-DhcpServerv4Scope | Select-Object ScopeId,SubnetMask,Name,StartRange,EndRange,LeaseDuration,State)
$leases = @()
foreach ($s in $scopes) {
  $leases += @(Get-DhcpServerv4Lease -ScopeId $s.ScopeId -AllLeases | Where-Object { $_.AddressState -like 'Active*' -or $_.AddressState -like '*Reservation*' } | Select-Object IPAddress,ClientId,HostName,LeaseExpiryTime,AddressState,ScopeId)
}
$options = @(Get-DhcpServerv4OptionValue -All | Select-Object OptionId,Value,ScopeId)
[pscustomobject]@{ scopes=$scopes; leases=$leases; options=$options } | ConvertTo-Json -Depth 4 -Compress
`

type windowsDoc struct {
	Scopes []struct {
		ScopeID       any    `json:"ScopeId"`
		SubnetMask    any    `json:"SubnetMask"`
		Name          string `json:"Name"`
		StartRange    any    `json:"StartRange"`
		EndRange      any    `json:"EndRange"`
		LeaseDuration any    `json:"LeaseDuration"`
		State         any    `json:"State"`
	} `json:"scopes"`
	Leases []struct {
		IPAddress       any    `json:"IPAddress"`
		ClientID        string `json:"ClientId"`
		HostName        string `json:"HostName"`
		LeaseExpiryTime any    `json:"LeaseExpiryTime"`
		AddressState    any    `json:"AddressState"`
		ScopeID         any    `json:"ScopeId"`
	} `json:"leases"`
}

// ipString reads PowerShell's IPAddress serialisation (string, or object with IPAddressToString).
func ipString(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case map[string]any:
		if s, ok := x["IPAddressToString"].(string); ok {
			return s
		}
		if s, ok := x["Address"].(float64); ok {
			n := uint32(s)
			return net.IPv4(byte(n), byte(n>>8), byte(n>>16), byte(n>>24)).String()
		}
	}
	return ""
}

func anyString(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64)
	case map[string]any:
		for _, k := range []string{"IPAddressToString", "TotalSeconds", "DateTime"} {
			if s, ok := x[k]; ok {
				return anyString(s)
			}
		}
	}
	return ""
}

func maskToPrefix(mask string) int {
	ip := net.ParseIP(mask).To4()
	if ip == nil {
		return 0
	}
	ones, _ := net.IPv4Mask(ip[0], ip[1], ip[2], ip[3]).Size()
	return ones
}

// ParseWindows decodes the Windows script document.
func ParseWindows(stdout string) ([]Scope, []Lease, error) {
	start := strings.Index(stdout, "{")
	if start < 0 {
		return nil, nil, collector.Errorf(contract.ErrParse, false, "dhcp script printed no JSON document")
	}
	var doc windowsDoc
	if err := json.Unmarshal([]byte(stdout[start:]), &doc); err != nil {
		return nil, nil, collector.Errorf(contract.ErrParse, false, "dhcp script JSON: %v", err)
	}
	var scopes []Scope
	cidrByScope := map[string]string{}
	for _, s := range doc.Scopes {
		id := ipString(s.ScopeID)
		prefix := maskToPrefix(ipString(s.SubnetMask))
		cidr := id + "/" + strconv.Itoa(prefix)
		cidrByScope[id] = cidr
		scopes = append(scopes, Scope{Name: s.Name, CIDR: cidr, Start: ipString(s.StartRange), End: ipString(s.EndRange), LeaseTTL: anyString(s.LeaseDuration), State: anyString(s.State)})
	}
	var leases []Lease
	for _, l := range doc.Leases {
		mac := normMac(l.ClientID)
		state := anyString(l.AddressState)
		leases = append(leases, Lease{Address: ipString(l.IPAddress), MAC: mac, Hostname: strings.TrimSuffix(strings.ToLower(l.HostName), "."), Expires: anyString(l.LeaseExpiryTime), State: state, ScopeCIDR: cidrByScope[ipString(l.ScopeID)], Static: strings.Contains(strings.ToLower(state), "reservation")})
	}
	return scopes, leases, nil
}

func normMac(s string) string {
	m := strings.ToLower(strings.NewReplacer("-", "", ":", "", ".", "").Replace(strings.TrimSpace(s)))
	if len(m) != 12 {
		return strings.ToLower(s)
	}
	parts := make([]string, 0, 6)
	for i := 0; i < 12; i += 2 {
		parts = append(parts, m[i:i+2])
	}
	return strings.Join(parts, ":")
}

// IscScript prints the configuration and the lease database with markers.
func IscScript(configPath, leasesPath string) string {
	return "set +e; export LC_ALL=C;\n" +
		sshexec.MarkerPrintf("config") + "; cat " + sshexec.ShellQuote(configPath) + " 2>/dev/null || sudo -n cat " + sshexec.ShellQuote(configPath) + ";\n" +
		sshexec.MarkerPrintf("leases") + "; cat " + sshexec.ShellQuote(leasesPath) + " 2>/dev/null || sudo -n cat " + sshexec.ShellQuote(leasesPath) + ";\n"
}

// ParseIscConfig reads `subnet X netmask Y { range A B; option routers R; option domain-name-servers ...; }` blocks.
func ParseIscConfig(text string) []Scope {
	var scopes []Scope
	var cur *Scope
	for _, raw := range strings.Split(text, "\n") {
		line := strings.TrimSpace(raw)
		if i := strings.Index(line, "#"); i >= 0 {
			line = strings.TrimSpace(line[:i])
		}
		if line == "" {
			continue
		}
		f := strings.Fields(strings.TrimSuffix(line, ";"))
		switch {
		case len(f) >= 4 && f[0] == "subnet" && f[2] == "netmask":
			cur = &Scope{CIDR: f[1] + "/" + strconv.Itoa(maskToPrefix(f[3])), Name: f[1], State: "active"}
			scopes = append(scopes, *cur)
			cur = &scopes[len(scopes)-1]
		case cur != nil && f[0] == "range" && len(f) >= 2:
			cur.Start = f[1]
			if len(f) >= 3 {
				cur.End = f[2]
			} else {
				cur.End = f[1]
			}
		case cur != nil && len(f) >= 3 && f[0] == "option" && f[1] == "routers":
			cur.Router = strings.Trim(f[2], ",")
		case cur != nil && len(f) >= 3 && f[0] == "option" && f[1] == "domain-name-servers":
			for _, d := range f[2:] {
				cur.DNS = append(cur.DNS, strings.Trim(d, ","))
			}
		case cur != nil && len(f) >= 2 && f[0] == "default-lease-time":
			cur.LeaseTTL = f[1]
		case strings.HasPrefix(line, "}"):
			cur = nil
		}
	}
	return scopes
}

// ParseIscLeases reads dhcpd.leases blocks; later blocks for the same address win (the file is a log).
func ParseIscLeases(text string, scopes []Scope) []Lease {
	byAddr := map[string]*Lease{}
	var order []string
	var cur *Lease
	for _, raw := range strings.Split(text, "\n") {
		line := strings.TrimSpace(raw)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		f := strings.Fields(strings.TrimSuffix(line, ";"))
		switch {
		case f[0] == "lease" && len(f) >= 2:
			l, ok := byAddr[f[1]]
			if !ok {
				l = &Lease{Address: f[1]}
				byAddr[f[1]] = l
				order = append(order, f[1])
			}
			l.MAC, l.Hostname, l.State, l.Expires = "", "", "", ""
			cur = l
		case cur != nil && f[0] == "hardware" && len(f) >= 3:
			cur.MAC = normMac(f[2])
		case cur != nil && f[0] == "client-hostname" && len(f) >= 2:
			cur.Hostname = strings.ToLower(strings.Trim(strings.Join(f[1:], " "), `"`))
		case cur != nil && f[0] == "binding" && len(f) >= 3:
			cur.State = f[2]
		case cur != nil && f[0] == "ends" && len(f) >= 4:
			cur.Expires = f[2] + " " + f[3]
		case strings.HasPrefix(line, "}"):
			cur = nil
		}
	}
	var out []Lease
	for _, a := range order {
		l := byAddr[a]
		if l.State != "" && l.State != "active" {
			continue
		}
		l.ScopeCIDR = scopeFor(l.Address, scopes)
		out = append(out, *l)
	}
	return out
}

// KeaScript prints the Kea configuration and the memfile lease CSV.
func KeaScript(configPath, leasesPath string) string {
	return IscScript(configPath, leasesPath)
}

type keaConfig struct {
	Dhcp4 struct {
		ValidLifetime int `json:"valid-lifetime"`
		Subnet4       []struct {
			Subnet string `json:"subnet"`
			Pools  []struct {
				Pool string `json:"pool"`
			} `json:"pools"`
			OptionData []struct {
				Name string `json:"name"`
				Data string `json:"data"`
			} `json:"option-data"`
		} `json:"subnet4"`
	} `json:"Dhcp4"`
}

// ParseKeaConfig reads subnet4 pools and options from kea-dhcp4.conf (JSON with optional comments).
func ParseKeaConfig(text string) []Scope {
	cleaned := stripComments(text)
	var cfg keaConfig
	if err := json.Unmarshal([]byte(cleaned), &cfg); err != nil {
		return nil
	}
	var scopes []Scope
	for _, s := range cfg.Dhcp4.Subnet4 {
		sc := Scope{CIDR: s.Subnet, Name: s.Subnet, State: "active", LeaseTTL: strconv.Itoa(cfg.Dhcp4.ValidLifetime)}
		if len(s.Pools) > 0 {
			start, end, _ := strings.Cut(s.Pools[0].Pool, "-")
			sc.Start, sc.End = strings.TrimSpace(start), strings.TrimSpace(end)
		}
		for _, o := range s.OptionData {
			switch o.Name {
			case "routers":
				sc.Router = o.Data
			case "domain-name-servers":
				for _, d := range strings.Split(o.Data, ",") {
					sc.DNS = append(sc.DNS, strings.TrimSpace(d))
				}
			}
		}
		scopes = append(scopes, sc)
	}
	return scopes
}

func stripComments(text string) string {
	var out []string
	for _, line := range strings.Split(text, "\n") {
		t := strings.TrimSpace(line)
		if strings.HasPrefix(t, "#") || strings.HasPrefix(t, "//") {
			continue
		}
		if i := strings.Index(line, " //"); i >= 0 {
			line = line[:i]
		}
		out = append(out, line)
	}
	return strings.Join(out, "\n")
}

// ParseKeaLeases reads the memfile CSV (address,hwaddr,client_id,valid_lifetime,expire,subnet_id,fqdn_fwd,fqdn_rev,hostname,state,...).
func ParseKeaLeases(text string, scopes []Scope) []Lease {
	byAddr := map[string]*Lease{}
	var order []string
	for i, line := range strings.Split(text, "\n") {
		if i == 0 || strings.TrimSpace(line) == "" {
			continue
		}
		f := strings.Split(line, ",")
		if len(f) < 10 {
			continue
		}
		l, ok := byAddr[f[0]]
		if !ok {
			l = &Lease{Address: f[0]}
			byAddr[f[0]] = l
			order = append(order, f[0])
		}
		l.MAC = normMac(f[1])
		l.Hostname = strings.ToLower(f[8])
		l.Expires = f[4]
		if f[9] == "0" {
			l.State = "active"
		} else {
			l.State = "declined-or-expired"
		}
		if exp, err := strconv.ParseInt(f[4], 10, 64); err == nil && exp == 0 {
			l.State = "released"
		}
	}
	var out []Lease
	for _, a := range order {
		l := byAddr[a]
		if l.State != "active" {
			continue
		}
		l.ScopeCIDR = scopeFor(l.Address, scopes)
		out = append(out, *l)
	}
	return out
}

func scopeFor(address string, scopes []Scope) string {
	ip := net.ParseIP(address)
	for _, s := range scopes {
		if _, n, err := net.ParseCIDR(s.CIDR); err == nil && ip != nil && n.Contains(ip) {
			return s.CIDR
		}
	}
	return ""
}

// Emit converts scopes and leases into observations. `server` is the DHCP server reference.
func Emit(server string, scopes []Scope, leases []Lease, raw []byte, at time.Time) collector.Observation {
	obs := collector.Observation{Evidence: []collector.RawEvidence{{Kind: evidenceKind, Data: raw}}}
	scopeRef := map[string]contract.CiRef{}
	leaseCount := map[string]int{}
	for _, l := range leases {
		leaseCount[l.ScopeCIDR]++
	}
	for _, s := range scopes {
		if s.CIDR == "" || strings.HasSuffix(s.CIDR, "/0") {
			continue
		}
		identity := map[string]string{"serverRef": server, "cidr": s.CIDR}
		ref := contract.CiRef{Type: typeScope, Identity: identity}
		scopeRef[s.CIDR] = ref
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeScope, Identity: identity, Name: firstNonEmpty(s.Name, s.CIDR),
			Attributes: map[string]any{"server": server, "cidr": s.CIDR, "rangeStart": s.Start, "rangeEnd": s.End, "router": s.Router, "dnsServers": s.DNS, "leaseTtl": s.LeaseTTL, "state": s.State, "activeLeases": leaseCount[s.CIDR], "poolSize": poolSize(s.Start, s.End)},
			Tags:       []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
		obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relInSubnet, From: ref, To: contract.CiRef{Type: typeSubnet, Identity: map[string]string{"cidr": s.CIDR, "vrfRef": defaultVrf}}, Attributes: map[string]any{}, ObservedAt: at})
	}
	for _, l := range leases {
		if l.Address == "" || l.ScopeCIDR == "" {
			continue
		}
		identity := map[string]string{"scopeRef": l.ScopeCIDR, "address": l.Address}
		ref := contract.CiRef{Type: typeLease, Identity: identity}
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeLease, Identity: identity, Name: l.Address + " " + l.Hostname,
			Attributes: map[string]any{"address": l.Address, "mac": l.MAC, "hostname": l.Hostname, "expires": l.Expires, "state": l.State, "reservation": l.Static, "server": server, "scope": l.ScopeCIDR},
			Tags:       []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
		if sc, ok := scopeRef[l.ScopeCIDR]; ok {
			obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relContains, From: sc, To: ref, Attributes: map[string]any{}, ObservedAt: at})
		}
		ipIdentity := map[string]string{"address": l.Address, "vrfRef": defaultVrf}
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeIP, Identity: ipIdentity, Name: l.Address, Attributes: map[string]any{"mac": l.MAC, "dnsName": l.Hostname, "allocation": map[bool]string{true: "reservation", false: "dynamic"}[l.Static], "source": collectorID}, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
		if l.MAC != "" {
			hostIdentity := map[string]string{"primaryMac": l.MAC}
			if l.Hostname != "" {
				hostIdentity["fqdn"] = l.Hostname
			}
			obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relLeasedTo, From: ref, To: contract.CiRef{Type: typeHost, Identity: hostIdentity}, Attributes: map[string]any{"mac": l.MAC}, ObservedAt: at})
		}
	}
	return obs
}

func poolSize(start, end string) int {
	a, b := net.ParseIP(start).To4(), net.ParseIP(end).To4()
	if a == nil || b == nil {
		return 0
	}
	toInt := func(ip net.IP) int { return int(ip[0])<<24 | int(ip[1])<<16 | int(ip[2])<<8 | int(ip[3]) }
	n := toInt(b) - toInt(a) + 1
	if n < 0 {
		return 0
	}
	return n
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
	mode, _ := options[optionMode].(string)
	configPath, _ := options[optionConfig].(string)
	leasesPath, _ := options[optionLeases].(string)
	switch strings.ToLower(mode) {
	case modeWindows:
		out, err := winrmexec.Run(ctx, target, cred, options, WindowsScript)
		if err != nil {
			return collector.Observation{}, err
		}
		scopes, leases, err := ParseWindows(out.Stdout)
		if err != nil {
			return collector.Observation{}, err
		}
		return Emit(target.Value, scopes, leases, []byte(out.Stdout), time.Now().UTC()), nil
	case modeISC, modeKea:
		if configPath == "" || leasesPath == "" {
			return collector.Observation{}, collector.Errorf(contract.ErrInternal, false, "dhcp job must name configPath and leasesPath for %s", mode)
		}
		out, err := sshexec.Run(ctx, target, cred, options, IscScript(configPath, leasesPath))
		if err != nil {
			return collector.Observation{}, err
		}
		sections, _ := sshexec.Split(string(out.Stdout))
		var scopes []Scope
		var leases []Lease
		if strings.ToLower(mode) == modeISC {
			scopes = ParseIscConfig(sections["config"])
			leases = ParseIscLeases(sections["leases"], scopes)
		} else {
			scopes = ParseKeaConfig(sections["config"])
			leases = ParseKeaLeases(sections["leases"], scopes)
		}
		if len(scopes) == 0 {
			return collector.Observation{}, collector.Errorf(contract.ErrParse, false, "%s: no subnets found in %s", target.Value, configPath)
		}
		return Emit(target.Value, scopes, leases, out.Stdout, time.Now().UTC()), nil
	default:
		return collector.Observation{}, collector.Errorf(contract.ErrInternal, false, "dhcp job must set mode to windows, isc or kea")
	}
}
