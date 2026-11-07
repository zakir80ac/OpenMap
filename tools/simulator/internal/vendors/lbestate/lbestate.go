// REQ-QA-005 REQ-DISC-018 — the load-balancing view of the synthetic estate shared by the F5, Citrix ADC,
// A10, HAProxy and NGINX simulators. The estate carries load balancer appliances (F5 BIG-IP pairs) and the
// bank applications behind them, but no virtual servers or pools: those are derived here, deterministically,
// from the estate's application components (tier, port, protocol), the VMs and hosts they run on, the
// listening services on those machines and their estate IP addresses. Addresses the estate does not hold
// (VIPs, management IPs of appliances the estate lacks) are allocated from the site's own estate subnets,
// skipping every address the estate already uses, so the same estate always yields the same plan.
package lbestate

import (
	"net/netip"
	"sort"
	"strconv"
	"strings"

	"github.com/openmap/openmap/tools/simulator/internal/estate"
	"github.com/openmap/openmap/tools/simulator/internal/sim"
)

const (
	typeApp       = "application"
	typeComponent = "application_component"
	typeListener  = "listening_service"
	typeIP        = "ip_address"
	typeSubnet    = "subnet"
	typeZone      = "dns_zone"
	relContains   = "contains"
	relRunsOn     = "runs_on"
	relUsesIP     = "uses_ip"
	reverseZone   = ".in-addr.arpa"
	// allocTop is the last host offset the allocator hands out; it walks down from the top of a subnet so
	// generated addresses stay clear of the gateway and the estate's bottom-up assignments.
	allocTop = 2
)

// Member is one backend endpoint: an estate machine (VM or host) and the listening service it runs on the
// component's port.
type Member struct {
	// Machine is the estate VM or host CI.
	Machine *estate.CI
	// Service is the estate listening_service on the component port (nil when the estate has none).
	Service *estate.CI
	// IP is the machine's estate ip_address CI (nil when the estate has none).
	IP *estate.CI
	// Address is the member IPv4 address.
	Address string
	// Host is the machine's short name and FQDN its fully qualified name.
	Host string
	FQDN string
	Port int
	Site string
}

// Pool is one application component's members at one site.
type Pool struct {
	App       *estate.CI
	Component *estate.CI
	// Name is the component name (for example cbs-web).
	Name     string
	Tier     string
	Port     int
	Protocol string
	Members  []Member
}

// Domain is the estate's forward DNS zone (bank.local in the synthetic estate).
func Domain(e *estate.Estate) string {
	for _, z := range e.OfType(typeZone, nil) {
		if !strings.HasSuffix(z.Name, reverseZone) {
			return z.Name
		}
	}
	return ""
}

func machineFQDN(m *estate.CI) string {
	if f := m.ID("fqdn"); f != "" {
		return strings.ToLower(f)
	}
	return strings.ToLower(m.Str("fqdn"))
}

// machineSite is the machine's site attribute, or the site of the estate subnet holding its address.
func machineSite(e *estate.Estate, m *estate.CI, addr string) string {
	if s := m.Str("site"); s != "" {
		return s
	}
	return SiteOf(e, firstNonEmpty(addr, m.Str("ipAddress"), m.Str("primaryIp")))
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

// Pools returns, in estate order, every application component that keep accepts, with its members at site.
// Components without a member at the site are left out.
func Pools(e *estate.Estate, site string, keep func(app, comp *estate.CI) bool) []Pool {
	var out []Pool
	for _, app := range e.OfType(typeApp, nil) {
		for _, comp := range e.From(app, relContains) {
			if comp.Type != typeComponent || (keep != nil && !keep(app, comp)) {
				continue
			}
			p := Pool{App: app, Component: comp, Name: comp.Name, Tier: comp.Str("tier"), Port: int(comp.Num("port", 0)), Protocol: comp.Str("protocol")}
			if p.Port == 0 {
				continue
			}
			for _, m := range e.From(comp, relRunsOn) {
				if mb := member(e, m, p.Port); mb.Site == site {
					p.Members = append(p.Members, mb)
				}
			}
			sort.SliceStable(p.Members, func(i, j int) bool { return p.Members[i].Host < p.Members[j].Host })
			if len(p.Members) > 0 {
				out = append(out, p)
			}
		}
	}
	return out
}

func member(e *estate.Estate, m *estate.CI, port int) Member {
	mb := Member{Machine: m, Host: m.Name, FQDN: machineFQDN(m), Port: port}
	for _, s := range e.To(m, relRunsOn) {
		if s.Type == typeListener && int(s.Num("port", 0)) == port {
			mb.Service = s
			mb.Address = s.Str("bindAddress")
			break
		}
	}
	for _, ip := range e.From(m, relUsesIP) {
		if ip.Type == typeIP {
			if mb.Address == "" || ip.ID("address") == mb.Address {
				mb.IP = ip
				mb.Address = ip.ID("address")
				break
			}
		}
	}
	mb.Address = firstNonEmpty(mb.Address, m.Str("ipAddress"), m.Str("primaryIp"))
	mb.Site = machineSite(e, m, mb.Address)
	return mb
}

// Sites lists the sites that have at least one pool member for keep, in first-seen order.
func Sites(e *estate.Estate, keep func(app, comp *estate.CI) bool) []string {
	seen := map[string]bool{}
	var out []string
	for _, app := range e.OfType(typeApp, nil) {
		for _, comp := range e.From(app, relContains) {
			if comp.Type != typeComponent || (keep != nil && !keep(app, comp)) {
				continue
			}
			for _, m := range e.From(comp, relRunsOn) {
				if s := member(e, m, int(comp.Num("port", 0))).Site; s != "" && !seen[s] {
					seen[s] = true
					out = append(out, s)
				}
			}
		}
	}
	return out
}

// SiteOf returns the site of the estate subnet holding addr (longest prefix with a site).
func SiteOf(e *estate.Estate, addr string) string {
	ip, err := netip.ParseAddr(addr)
	if err != nil {
		return ""
	}
	best, bestBits := "", -1
	for _, s := range e.OfType(typeSubnet, nil) {
		p, err := netip.ParsePrefix(s.ID("cidr"))
		if err != nil || !p.Contains(ip) || s.Str("site") == "" {
			continue
		}
		if p.Bits() > bestBits {
			best, bestBits = s.Str("site"), p.Bits()
		}
	}
	return best
}

// Allocator hands out addresses the estate does not use, from a site's subnets of one purpose.
type Allocator struct {
	used     map[netip.Addr]bool
	prefixes []netip.Prefix
	next     []int
}

// NewAllocator prepares allocation from the site's subnets whose purpose matches (in estate order; the
// last such subnet is used first, since the estate fills the first ones).
func NewAllocator(e *estate.Estate, site, purpose string) *Allocator {
	a := &Allocator{used: map[netip.Addr]bool{}}
	for _, ip := range e.OfType(typeIP, nil) {
		if addr, err := netip.ParseAddr(ip.ID("address")); err == nil {
			a.used[addr] = true
		}
	}
	for _, s := range e.OfType(typeSubnet, func(c *estate.CI) bool { return c.Str("site") == site && c.Str("purpose") == purpose }) {
		if p, err := netip.ParsePrefix(s.ID("cidr")); err == nil && p.Addr().Is4() {
			a.prefixes = append([]netip.Prefix{p.Masked()}, a.prefixes...)
			a.next = append(a.next, 0)
		}
	}
	return a
}

// Next returns the next free address ("" when the subnets are exhausted).
func (a *Allocator) Next() string {
	for i, p := range a.prefixes {
		size := 1 << (32 - p.Bits())
		for a.next[i] < size-2*allocTop {
			off := size - allocTop - a.next[i]
			a.next[i]++
			b := p.Addr().As4()
			n := uint32(b[0])<<24 | uint32(b[1])<<16 | uint32(b[2])<<8 | uint32(b[3])
			n += uint32(off)
			addr := netip.AddrFrom4([4]byte{byte(n >> 24), byte(n >> 16), byte(n >> 8), byte(n)})
			if !a.used[addr] {
				a.used[addr] = true
				return addr.String()
			}
		}
	}
	return ""
}

// Endpoint formats address:port.
func Endpoint(addr string, port int) string { return addr + ":" + strconv.Itoa(port) }

// Expect adds expectations once each: a collector emits a CI or relationship once even when the plan
// reaches it twice (a member behind two virtual servers).
type Expect struct {
	x    *sim.Expect
	seen map[string]bool
}

func NewExpect(x *sim.Expect) *Expect { return &Expect{x: x, seen: map[string]bool{}} }

// CI expects a CI by type and name; identity (estate identity, may be nil) feeds the drift check.
func (ex *Expect) CI(ciType, name string, identity map[string]string) {
	k := "ci\x00" + ciType + "\x00" + strings.ToLower(name)
	if ex.seen[k] {
		return
	}
	ex.seen[k] = true
	ex.x.CIs = append(ex.x.CIs, sim.ExpectCI{Type: ciType, Name: name, Identity: identity})
}

// Rel expects a relationship between two emitted CIs.
func (ex *Expect) Rel(relType, fromType, from, toType, to string) {
	k := "rel\x00" + relType + "\x00" + fromType + "\x00" + strings.ToLower(from) + "\x00" + toType + "\x00" + strings.ToLower(to)
	if ex.seen[k] {
		return
	}
	ex.seen[k] = true
	ex.x.Rel(relType, fromType, from, toType, to)
}

// RelToRef expects a relationship from an emitted CI to a reference-only CI.
func (ex *Expect) RelToRef(relType, fromType, from, toType string, toIdentity map[string]string) {
	k := "ref\x00" + relType + "\x00" + fromType + "\x00" + strings.ToLower(from) + "\x00" + estate.Key(toType, toIdentity)
	if ex.seen[k] {
		return
	}
	ex.seen[k] = true
	ex.x.RelToRef(relType, fromType, from, toType, toIdentity)
}

// Member expects a pool member as a collector emits it: the listening service under the collector's name
// carrying the estate service identity, its address as an ip_address carrying the estate IP identity, and
// the uses_ip edge between them.
func (ex *Expect) Member(m Member, name string) {
	var sid, iid map[string]string
	if m.Service != nil {
		sid = m.Service.Identity
	}
	if m.IP != nil {
		iid = m.IP.Identity
	}
	ex.CI(typeListener, name, sid)
	ex.CI(typeIP, m.Address, iid)
	ex.Rel(relUsesIP, typeListener, name, typeIP, m.Address)
}

// Up reports whether the estate machine is powered on (members of powered-off machines are down).
func (m Member) Up() bool {
	p := m.Machine.Str("powerState")
	return p == "poweredOn" || p == "on"
}
