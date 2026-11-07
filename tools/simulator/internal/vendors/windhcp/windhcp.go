// REQ-QA-005 REQ-DISC-022 — simulated Windows DHCP Server behind WinRM for the dhcp collector (mode windows). Each
// DHCP server the estate's scopes name answers the collector's script with its DNS name and what
// Get-DhcpServerv4Scope, Get-DhcpServerv4Lease and Get-DhcpServerv4OptionValue print through ConvertTo-Json
// (IPAddress values as System.Net.IPAddress objects, LeaseDuration as a TimeSpan object, expiry as \/Date(ms)\/).
//
// From the estate: every scope (CIDR, name, range, gateway as option 3, DNS servers as option 6, lease time) and
// every lease it contains (address, MAC as the dash-separated ClientId, host name, expiry, state). The server
// itself is the scopes' serverRef; the estate has no host CI for it, so only its name is rendered.
package windhcp

import (
	"context"
	"encoding/binary"
	"net"
	"sort"
	"strings"
	"time"

	"github.com/openmap/openmap/tools/simulator/internal/estate"
	"github.com/openmap/openmap/tools/simulator/internal/protocols/winrm"
	"github.com/openmap/openmap/tools/simulator/internal/sim"
	"github.com/openmap/openmap/tools/simulator/internal/vendors/windows"
)

const (
	signature       = "Get-DhcpServerv4Scope"
	familyV4        = 2
	optionRouter    = 3
	optionDNS       = 6
	optionDomain    = 15
	defaultLeaseSec = 691200
	ticksPerSecond  = 10000000
	secondsPerMin   = 60
	secondsPerHour  = 3600
	secondsPerDay   = 86400
	millisPerSecond = 1000
	jobTimeoutMs    = 300000
	defaultVrf      = "default"
)

type Vendor struct{}

func (Vendor) ID() string             { return "windows-dhcp" }
func (Vendor) Collector() string      { return "dhcp" }
func (Vendor) Requirements() []string { return []string{"REQ-DISC-022"} }

// Server is one simulated Windows DHCP server with the estate scopes it serves.
type Server struct {
	FQDN   string
	Scopes []*estate.CI
	Leases map[*estate.CI][]*estate.CI
}

// Servers groups the estate's DHCP scopes by the server that serves them.
func Servers(e *estate.Estate) []*Server {
	byName := map[string]*Server{}
	var names []string
	for _, sc := range e.OfType("dhcp_scope", nil) {
		name := strings.ToLower(firstNonEmpty(sc.ID("serverRef"), sc.Str("server")))
		if name == "" {
			continue
		}
		s, ok := byName[name]
		if !ok {
			s = &Server{FQDN: name, Leases: map[*estate.CI][]*estate.CI{}}
			byName[name] = s
			names = append(names, name)
		}
		s.Scopes = append(s.Scopes, sc)
		for _, l := range e.From(sc, "contains") {
			if l.Type == "dhcp_lease" {
				s.Leases[sc] = append(s.Leases[sc], l)
			}
		}
	}
	sort.Strings(names)
	out := make([]*Server, 0, len(names))
	for _, n := range names {
		out = append(out, byName[n])
	}
	return out
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

// ipAddress is System.Net.IPAddress as ConvertTo-Json writes an IPv4 address.
func ipAddress(s string) map[string]any {
	ip := net.ParseIP(s).To4()
	var addr uint32
	if ip != nil {
		addr = binary.LittleEndian.Uint32(ip)
	}
	return map[string]any{"Address": addr, "AddressFamily": familyV4, "ScopeId": nil, "IsIPv6Multicast": false, "IsIPv6LinkLocal": false, "IsIPv6SiteLocal": false,
		"IsIPv6Teredo": false, "IsIPv4MappedToIPv6": false, "IPAddressToString": s}
}

// timeSpan is System.TimeSpan as ConvertTo-Json writes it.
func timeSpan(seconds int64) map[string]any {
	return map[string]any{"Ticks": seconds * ticksPerSecond, "Days": seconds / secondsPerDay, "Hours": seconds % secondsPerDay / secondsPerHour, "Milliseconds": 0,
		"Minutes": seconds % secondsPerHour / secondsPerMin, "Seconds": seconds % secondsPerMin, "TotalDays": float64(seconds) / secondsPerDay,
		"TotalHours": float64(seconds) / secondsPerHour, "TotalMilliseconds": seconds * millisPerSecond, "TotalMinutes": float64(seconds) / secondsPerMin, "TotalSeconds": seconds}
}

func network(cidr string) (string, string) {
	_, n, err := net.ParseCIDR(cidr)
	if err != nil {
		return "", ""
	}
	return n.IP.String(), net.IP(n.Mask).String()
}

// LeaseName is the collector's dhcp_lease name.
func LeaseName(l *estate.CI) string {
	return l.ID("address") + " " + strings.TrimSuffix(strings.ToLower(l.Str("hostname")), ".")
}

func expiry(l *estate.CI) any {
	t, err := time.Parse(time.RFC3339, l.Str("expiresAt"))
	if err != nil {
		return nil
	}
	return winrm.Date(t)
}

// Document renders what the collector's script prints on the server.
func (s *Server) Document() map[string]any {
	scopes, leases := []any{}, []any{}
	options := []any{map[string]any{"OptionId": optionDomain, "Value": []string{s.FQDN[strings.Index(s.FQDN, ".")+1:]}, "ScopeId": nil}}
	for _, sc := range s.Scopes {
		id, mask := network(sc.ID("cidr"))
		scopes = append(scopes, map[string]any{"ScopeId": ipAddress(id), "SubnetMask": ipAddress(mask), "Name": sc.Name, "StartRange": ipAddress(sc.Str("rangeStart")),
			"EndRange": ipAddress(sc.Str("rangeEnd")), "LeaseDuration": timeSpan(int64(sc.Num("leaseSeconds", defaultLeaseSec))), "State": "Active"})
		for _, l := range s.Leases[sc] {
			leases = append(leases, map[string]any{"IPAddress": ipAddress(l.ID("address")), "ClientId": strings.ReplaceAll(strings.ToLower(l.Str("mac")), ":", "-"),
				"HostName": l.Str("hostname"), "LeaseExpiryTime": expiry(l), "AddressState": "Active", "ScopeId": ipAddress(id)})
		}
		if g := sc.Str("gateway"); g != "" {
			options = append(options, map[string]any{"OptionId": optionRouter, "Value": []string{g}, "ScopeId": id})
		}
		if d := sc.Strs("dnsServers"); len(d) > 0 {
			options = append(options, map[string]any{"OptionId": optionDNS, "Value": d, "ScopeId": id})
		}
	}
	return map[string]any{"server": s.FQDN, "scopes": scopes, "leases": leases, "options": options}
}

// Script answers the collector's DHCP script on the server.
func (s *Server) Script(script string) winrm.Output {
	if !strings.Contains(script, signature) {
		return winrm.Unsupported(winrm.FirstCmdlet(script))
	}
	return winrm.Output{Stdout: winrm.JSON(s.Document())}
}

func (Vendor) Start(_ context.Context, e *estate.Estate, env *sim.Env) (*sim.Endpoint, error) {
	servers := Servers(e)
	keys := make([]string, len(servers))
	byKey := map[string]*Server{}
	for i, s := range servers {
		keys[i] = s.FQDN
		byKey[keys[i]] = s
	}
	return winrm.Serve(env, keys, func(k string) winrm.Script { return byKey[k].Script })
}

func (Vendor) Runs(e *estate.Estate, ep *sim.Endpoint, env *sim.Env) []sim.Run {
	servers := Servers(e)
	keys := make([]string, len(servers))
	byKey := map[string]*Server{}
	for i, s := range servers {
		keys[i] = s.FQDN
		byKey[keys[i]] = s
	}
	return windows.Plan("windows-dhcp", ep, env, keys, map[string]any{"mode": "windows"}, jobTimeoutMs, func(x *sim.Expect, fqdn string) {
		s := byKey[fqdn]
		for _, sc := range s.Scopes {
			x.EstateCI(sc)
			x.RelToRef("in_subnet", "dhcp_scope", sc.Name, "subnet", map[string]string{"cidr": sc.ID("cidr"), "vrfRef": defaultVrf})
			for _, l := range s.Leases[sc] {
				name := LeaseName(l)
				addr := l.ID("address")
				x.CIs = append(x.CIs, sim.ExpectCI{Type: "dhcp_lease", Name: name, Identity: l.Identity})
				x.Rel("contains", "dhcp_scope", sc.Name, "dhcp_lease", name)
				x.CIs = append(x.CIs, sim.ExpectCI{Type: "ip_address", Name: addr, Identity: map[string]string{"address": addr, "vrfRef": defaultVrf}})
				x.RelToRef("leased_to", "dhcp_lease", name, "host", map[string]string{"primaryMac": strings.ToLower(l.Str("mac"))})
			}
		}
	})
}
