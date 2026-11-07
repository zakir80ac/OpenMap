// REQ-QA-005 REQ-DISC-022 — simulated Linux DHCP servers over SSH for the dhcp collector's isc and kea modes (the
// Windows DHCP path over WinRM is simulated elsewhere). The estate's DHCP server (its dhcp_scope CIs and the
// dhcp_lease CIs they contain) is served twice, each by its own SSH daemon with a per-server host key: as Kea
// (kea-dhcp4.conf with subnet4 pools and option-data, and the memfile lease CSV) and as ISC dhcpd (dhcpd.conf
// subnet blocks and the dhcpd.leases journal, where each address first appears in an older, released block and
// then in its current active one, as the journal records a re-lease). The formats follow the recorded Kea 2.2 and
// ISC dhcpd 4.4.3 transcripts under packages/testing/fixtures/vendor/dhcp. A file is printed only when the
// collector's `cat` names the path the server keeps it at; any other path prints nothing, like a missing file.
package dhcpssh

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"strconv"
	"strings"
	"time"

	"github.com/openmap/openmap/tools/simulator/internal/estate"
	"github.com/openmap/openmap/tools/simulator/internal/protocols/sshd"
	"github.com/openmap/openmap/tools/simulator/internal/sim"
)

const (
	modeKea         = "kea"
	modeISC         = "isc"
	keaConfigPath   = "/etc/kea/kea-dhcp4.conf"
	keaLeasesPath   = "/var/lib/kea/kea-leases4.csv"
	iscConfigPath   = "/etc/dhcp/dhcpd.conf"
	iscLeasesPath   = "/var/lib/dhcp/dhcpd.leases"
	sectionConfig   = "config"
	sectionLeases   = "leases"
	iscTimeLayout   = "2006/01/02 15:04:05"
	keaStateDefault = "0"
	// defaultLeaseSeconds applies when a scope carries no lease time.
	defaultLeaseSeconds = 86400
	ipv4Bits            = 32
)

type Vendor struct{}

func (Vendor) ID() string             { return "dhcp-linux-ssh" }
func (Vendor) Collector() string      { return "dhcp" }
func (Vendor) Requirements() []string { return []string{"REQ-DISC-022"} }

type lease struct {
	ci      *estate.CI
	expires time.Time
}

type scope struct {
	ci     *estate.CI
	leases []lease
}

type dhcpServer struct {
	mode     string
	name     string
	scopes   []scope
	server   *sshd.Server
	cfgPath  string
	leasPath string
}

func loadScopes(e *estate.Estate) (string, []scope) {
	var out []scope
	server := ""
	for _, s := range e.OfType("dhcp_scope", nil) {
		if server == "" {
			server = s.ID("serverRef")
		}
		if s.ID("serverRef") != server {
			continue
		}
		sc := scope{ci: s}
		for _, l := range e.From(s, "contains") {
			if l.Type != "dhcp_lease" {
				continue
			}
			exp, err := time.Parse(time.RFC3339Nano, l.Str("expiresAt"))
			if err != nil {
				continue
			}
			sc.leases = append(sc.leases, lease{ci: l, expires: exp.UTC()})
		}
		out = append(out, sc)
	}
	return server, out
}

func leaseSeconds(s *estate.CI) int { return int(s.Num("leaseSeconds", defaultLeaseSeconds)) }

func netmask(cidr string) (string, string) {
	ip, n, err := net.ParseCIDR(cidr)
	if err != nil {
		return "", ""
	}
	ones, _ := n.Mask.Size()
	m := net.CIDRMask(ones, ipv4Bits)
	return ip.Mask(m).String(), net.IP(m).String()
}

// --- Kea ---

type keaOption struct {
	Name string `json:"name"`
	Data string `json:"data"`
}

type keaPool struct {
	Pool string `json:"pool"`
}

type keaSubnet struct {
	ID         int         `json:"id"`
	Subnet     string      `json:"subnet"`
	Pools      []keaPool   `json:"pools"`
	OptionData []keaOption `json:"option-data"`
}

func (d *dhcpServer) keaConfig() string {
	subnets := make([]keaSubnet, 0, len(d.scopes))
	lifetime := defaultLeaseSeconds
	for i, s := range d.scopes {
		c := s.ci
		lifetime = leaseSeconds(c)
		sn := keaSubnet{ID: i + 1, Subnet: c.Str("cidr"), Pools: []keaPool{{Pool: c.Str("rangeStart") + " - " + c.Str("rangeEnd")}},
			OptionData: []keaOption{{Name: "routers", Data: c.Str("gateway")}}}
		if dns := c.Strs("dnsServers"); len(dns) > 0 {
			sn.OptionData = append(sn.OptionData, keaOption{Name: "domain-name-servers", Data: strings.Join(dns, ", ")})
		}
		subnets = append(subnets, sn)
	}
	doc := map[string]any{"Dhcp4": map[string]any{
		"interfaces-config": map[string]any{"interfaces": []string{"ens192"}},
		"lease-database":    map[string]any{"type": "memfile", "persist": true, "name": keaLeasesPath, "lfc-interval": 3600},
		"valid-lifetime":    lifetime, "subnet4": subnets,
	}}
	body, _ := json.MarshalIndent(doc, "", "  ")
	return "// " + d.name + ": Kea DHCPv4 (relayed branch scopes)\n" + string(body)
}

func (d *dhcpServer) keaLeases() string {
	var b strings.Builder
	b.WriteString("address,hwaddr,client_id,valid_lifetime,expire,subnet_id,fqdn_fwd,fqdn_rev,hostname,state,user_context\n")
	for i, s := range d.scopes {
		for _, l := range s.leases {
			c := l.ci
			fmt.Fprintf(&b, "%s,%s,%s,%d,%d,%d,0,0,%s,%s,\n", c.Str("address"), c.Str("mac"), c.Str("clientId"), leaseSeconds(s.ci), l.expires.Unix(), i+1, c.Str("hostname"), keaStateDefault)
		}
	}
	return b.String()
}

// --- ISC dhcpd ---

func (d *dhcpServer) iscConfig() string {
	var b strings.Builder
	b.WriteString("# " + d.name + ": ISC dhcpd (relayed branch scopes)\nauthoritative;\noption domain-name \"bank.local\";\ndefault-lease-time 86400;\nmax-lease-time 172800;\nddns-update-style none;\n\n")
	for _, s := range d.scopes {
		c := s.ci
		network, mask := netmask(c.Str("cidr"))
		fmt.Fprintf(&b, "# %s\nsubnet %s netmask %s {\n  range %s %s;\n  option routers %s;\n", s.ci.Name, network, mask, c.Str("rangeStart"), c.Str("rangeEnd"), c.Str("gateway"))
		if dns := c.Strs("dnsServers"); len(dns) > 0 {
			b.WriteString("  option domain-name-servers " + strings.Join(dns, ", ") + ";\n")
		}
		fmt.Fprintf(&b, "  default-lease-time %d;\n}\n\n", leaseSeconds(c))
	}
	return b.String()
}

func iscTime(t time.Time) string {
	return strconv.Itoa(int(t.Weekday())) + " " + t.Format(iscTimeLayout)
}

func iscBlock(addr, mac, uid, host, state, next string, starts, ends time.Time) string {
	return fmt.Sprintf("lease %s {\n  starts %s;\n  ends %s;\n  cltt %s;\n  binding state %s;\n  next binding state %s;\n  rewind binding state free;\n  hardware ethernet %s;\n  uid \"%s\";\n  client-hostname \"%s\";\n}\n",
		addr, iscTime(starts), iscTime(ends), iscTime(starts), state, next, mac, uid, host)
}

func (d *dhcpServer) iscLeases() string {
	var b strings.Builder
	b.WriteString("# The format of this file is documented in the dhcpd.leases(5) manual page.\n# This lease file was written by isc-dhcp-4.4.3-P1\n\n# authoring-byte-order entry is generated, DO NOT DELETE\nauthoring-byte-order little-endian;\n\n")
	for _, s := range d.scopes {
		ttl := time.Duration(leaseSeconds(s.ci)) * time.Second
		for _, l := range s.leases {
			c := l.ci
			starts := l.expires.Add(-ttl)
			b.WriteString(iscBlock(c.Str("address"), c.Str("mac"), c.Str("clientId"), c.Str("hostname"), "free", "free", starts.Add(-ttl), starts))
			b.WriteString(iscBlock(c.Str("address"), c.Str("mac"), c.Str("clientId"), c.Str("hostname"), "active", "free", starts, l.expires))
		}
	}
	return b.String()
}

func (d *dhcpServer) file(path string) string {
	switch {
	case d.mode == modeKea && path == keaConfigPath:
		return d.keaConfig()
	case d.mode == modeKea && path == keaLeasesPath:
		return d.keaLeases()
	case d.mode == modeISC && path == iscConfigPath:
		return d.iscConfig()
	case d.mode == modeISC && path == iscLeasesPath:
		return d.iscLeases()
	}
	return ""
}

func (d *dhcpServer) render(script string) string {
	var b strings.Builder
	for _, s := range sshd.Sections(script) {
		body := ""
		for _, p := range []string{d.cfgPath, d.leasPath} {
			if strings.Contains(s.Command, "cat '"+p+"'") {
				body = d.file(p)
			}
		}
		b.WriteString(sshd.Frame(s.Key, body))
	}
	return b.String()
}

func (Vendor) Start(_ context.Context, e *estate.Estate, env *sim.Env) (*sim.Endpoint, error) {
	name, scopes := loadScopes(e)
	all := []*dhcpServer{
		{mode: modeKea, name: name, scopes: scopes, cfgPath: keaConfigPath, leasPath: keaLeasesPath},
		{mode: modeISC, name: name, scopes: scopes, cfgPath: iscConfigPath, leasPath: iscLeasesPath},
	}
	if len(scopes) == 0 {
		all = nil
	}
	ep := &sim.Endpoint{Host: sim.AdvertiseHost(), State: map[string]any{"servers": all}}
	for _, d := range all {
		srv, err := sshd.Serve(env, sshd.Shell(d.render), sshd.Config{})
		if err != nil {
			_ = ep.Close()
			return nil, err
		}
		d.server = srv
		ep.OnClose(srv.Close)
	}
	return ep, nil
}

func (Vendor) Runs(_ *estate.Estate, ep *sim.Endpoint, env *sim.Env) []sim.Run {
	all, _ := ep.State["servers"].([]*dhcpServer)
	var runs []sim.Run
	for _, d := range all {
		cred := sshd.PasswordCredential(env)
		opts := d.server.Options()
		opts["mode"], opts["configPath"], opts["leasesPath"] = d.mode, d.cfgPath, d.leasPath
		run := sim.Run{Name: d.mode, Targets: []sim.Target{d.server.Target(d.name)}, Options: opts, CredentialType: cred.Type, Credential: cred}
		x := &run.Expect
		for _, s := range d.scopes {
			cidr := s.ci.Str("cidr")
			// Kea names a scope by its subnet, ISC dhcpd by the network address of its subnet block.
			scopeName := cidr
			if d.mode == modeISC {
				scopeName, _ = netmask(cidr)
			}
			x.CIs = append(x.CIs, sim.ExpectCI{Type: "dhcp_scope", Name: scopeName, Identity: s.ci.Identity})
			x.RelToRef("in_subnet", "dhcp_scope", scopeName, "subnet", map[string]string{"cidr": cidr})
			for _, l := range s.leases {
				c := l.ci
				leaseName := c.Str("address") + " " + strings.ToLower(c.Str("hostname"))
				x.CIs = append(x.CIs, sim.ExpectCI{Type: "dhcp_lease", Name: leaseName, Identity: c.Identity})
				x.Rel("contains", "dhcp_scope", scopeName, "dhcp_lease", leaseName)
				x.CI("ip_address", c.Str("address"))
				x.RelToRef("leased_to", "dhcp_lease", leaseName, "host", map[string]string{"primaryMac": strings.ToLower(c.Str("mac"))})
			}
		}
		runs = append(runs, run)
	}
	return runs
}
