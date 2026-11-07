// REQ-QA-005 REQ-DISC-021 — simulated authoritative DNS servers: the estate's dns_zone and dns_record CIs are
// served over AXFR by three loopback servers flavoured as ISC BIND 9.18 (TSIG hmac-sha512 transfer key, many
// records per message), Windows Server 2022 DNS (unsigned transfers to listed secondaries, Windows SOA timer
// defaults, one record per message as with "BIND secondaries" compatibility) and Infoblox NIOS 9 (TSIG
// hmac-sha256, the NIOS default SOA mailbox). The dns collector transfers both estate zones from each.
// The collector speaks AXFR only (no Infoblox WAPI or Route 53 paths), so only DNS is simulated.
package dnszone

import (
	"context"
	"encoding/base64"
	"net"
	"strings"

	"github.com/miekg/dns"

	"github.com/openmap/openmap/tools/simulator/internal/estate"
	"github.com/openmap/openmap/tools/simulator/internal/protocols/dnsd"
	"github.com/openmap/openmap/tools/simulator/internal/sim"
)

const (
	typeZone   = "dns_zone"
	typeRecord = "dns_record"
	typeIP     = "ip_address"
	defaultTTL = 3600
	// SOA timers: BIND's documented defaults, Windows DNS defaults (15 min refresh, 10 min retry, 1 day expire).
	bindRefresh, bindRetry, bindExpire, bindMinimum = 7200, 3600, 1209600, 3600
	winRefresh, winRetry, winExpire, winMinimum     = 900, 600, 86400, 3600
	niosRefresh, niosRetry, niosExpire, niosMinimum = 10800, 3600, 2419200, 900
	// manyAnswers approximates how many RRs BIND and NIOS (BIND-based) pack into one AXFR message.
	manyAnswers = 100
	oneAnswer   = 1
	bindKey     = "openmap-xfr."
	infobloxKey = "infoblox-xfr."
	// infobloxMailbox is the SOA responsible mailbox NIOS uses until an administrator sets one.
	infobloxMailbox = "please_set_email.absolutely.nowhere."
)

type Vendor struct{}

func (Vendor) ID() string             { return "dns-authoritative" }
func (Vendor) Collector() string      { return "dns" }
func (Vendor) Requirements() []string { return []string{"REQ-DISC-021"} }

type flavour struct {
	dnsd.Flavour
	algOption string // tsigAlgorithm job option ("" leaves the collector default, hmac-sha256)
}

func flavours(primary, zone string) []flavour {
	host := strings.ToLower(dns.Fqdn(primary))
	return []flavour{
		{Flavour: dnsd.Flavour{Name: "bind", MName: host, RName: "hostmaster." + zone, Refresh: bindRefresh, Retry: bindRetry, Expire: bindExpire, Minimum: bindMinimum,
			RecordsPerMessage: manyAnswers, TSIGKey: bindKey, TSIGAlgorithm: dns.HmacSHA512, Version: "9.18.28"}, algOption: "hmac-sha512"},
		{Flavour: dnsd.Flavour{Name: "windows-dns", MName: host, RName: "hostmaster." + zone, Refresh: winRefresh, Retry: winRetry, Expire: winExpire, Minimum: winMinimum,
			RecordsPerMessage: oneAnswer}},
		{Flavour: dnsd.Flavour{Name: "infoblox", MName: host, RName: infobloxMailbox, Refresh: niosRefresh, Retry: niosRetry, Expire: niosExpire, Minimum: niosMinimum,
			RecordsPerMessage: manyAnswers, TSIGKey: infobloxKey, TSIGAlgorithm: dns.HmacSHA256}},
	}
}

type zoneView struct {
	ci      *estate.CI
	records []*estate.CI
	zone    dnsd.Zone
}

func header(name string, t uint16, ttl uint32) dns.RR_Header {
	return dns.RR_Header{Name: dns.Fqdn(strings.ToLower(name)), Rrtype: t, Class: dns.ClassINET, Ttl: ttl}
}

func rrOf(c *estate.CI) dns.RR {
	ttl := uint32(c.Num("ttl", defaultTTL))
	value := c.ID("value")
	switch c.ID("recordType") {
	case "A":
		if ip := net.ParseIP(value).To4(); ip != nil {
			return &dns.A{Hdr: header(c.ID("name"), dns.TypeA, ttl), A: ip}
		}
	case "AAAA":
		if ip := net.ParseIP(value); ip != nil {
			return &dns.AAAA{Hdr: header(c.ID("name"), dns.TypeAAAA, ttl), AAAA: ip}
		}
	case "CNAME":
		return &dns.CNAME{Hdr: header(c.ID("name"), dns.TypeCNAME, ttl), Target: dns.Fqdn(value)}
	case "PTR":
		return &dns.PTR{Hdr: header(c.ID("name"), dns.TypePTR, ttl), Ptr: dns.Fqdn(value)}
	case "TXT":
		return &dns.TXT{Hdr: header(c.ID("name"), dns.TypeTXT, ttl), Txt: []string{value}}
	}
	return nil
}

func zones(e *estate.Estate) []*zoneView {
	byZone := map[string][]*estate.CI{}
	for _, r := range e.OfType(typeRecord, nil) {
		byZone[strings.ToLower(r.ID("zoneRef"))] = append(byZone[strings.ToLower(r.ID("zoneRef"))], r)
	}
	var out []*zoneView
	for _, z := range e.OfType(typeZone, nil) {
		name := strings.ToLower(z.ID("name"))
		ttl := uint32(z.Num("ttl", defaultTTL))
		v := &zoneView{ci: z, zone: dnsd.Zone{Name: name, Serial: uint32(z.Num("serial", 1)), TTL: ttl}}
		for _, ns := range z.Strs("nameservers") {
			v.zone.Records = append(v.zone.Records, &dns.NS{Hdr: header(name, dns.TypeNS, ttl), Ns: dns.Fqdn(strings.ToLower(ns))})
		}
		for _, r := range byZone[name] {
			if rr := rrOf(r); rr != nil {
				v.records = append(v.records, r)
				v.zone.Records = append(v.zone.Records, rr)
			}
		}
		out = append(out, v)
	}
	return out
}

func primary(views []*zoneView) (string, string) {
	for _, v := range views {
		if ns := v.ci.Strs("nameservers"); len(ns) > 0 {
			return ns[0], dns.Fqdn(v.zone.Name)
		}
	}
	return "ns1.simulated.invalid", "simulated.invalid."
}

func tsigSecret(env *sim.Env) string { return base64.StdEncoding.EncodeToString([]byte(env.Secret)) }

func (Vendor) Start(_ context.Context, e *estate.Estate, env *sim.Env) (*sim.Endpoint, error) {
	views := zones(e)
	ep := &sim.Endpoint{Host: sim.AdvertiseHost(), State: map[string]any{}}
	if len(views) == 0 {
		return ep, nil
	}
	ns, apex := primary(views)
	var zs []dnsd.Zone
	for _, v := range views {
		zs = append(zs, v.zone)
	}
	secrets := map[string]string{bindKey: tsigSecret(env), infobloxKey: tsigSecret(env)}
	for _, f := range flavours(ns, apex) {
		ln, _, err := sim.Listen()
		if err != nil {
			_ = ep.Close()
			return nil, err
		}
		srv, err := dnsd.Serve(f.Flavour, zs, secrets, ln)
		if err != nil {
			_ = ep.Close()
			return nil, err
		}
		ep.OnClose(srv.Close)
		ep.State["port:"+f.Name] = srv.Port
	}
	return ep, nil
}

func (Vendor) Runs(e *estate.Estate, ep *sim.Endpoint, env *sim.Env) []sim.Run {
	views := zones(e)
	if len(views) == 0 {
		return nil
	}
	ips := map[string]*estate.CI{}
	for _, c := range e.OfType(typeIP, nil) {
		ips[c.Name] = c
	}
	ns, apex := primary(views)
	var names []any
	for _, v := range views {
		names = append(names, v.zone.Name)
	}
	var runs []sim.Run
	for _, f := range flavours(ns, apex) {
		run := sim.Run{
			Name:           f.Name,
			Targets:        []sim.Target{{Kind: "host", Value: ep.Host, Label: f.Name}},
			Options:        map[string]any{"port": ep.State["port:"+f.Name], "zones": names},
			CredentialType: "none",
		}
		if f.TSIGKey != "" {
			run.CredentialType = "api_token"
			run.Credential = &sim.Credential{Type: "api_token", Fields: map[string]string{"token": tsigSecret(env)}}
			run.Options["tsigKeyName"] = strings.TrimSuffix(f.TSIGKey, ".")
			if f.algOption != "" {
				run.Options["tsigAlgorithm"] = f.algOption
			}
		}
		seenIP := map[string]bool{}
		for _, v := range views {
			run.Expect.EstateCI(v.ci)
			for _, r := range v.records {
				// The collector names a record "<owner> <type>"; the estate identity is carried for the drift check.
				name := strings.ToLower(r.ID("name")) + " " + r.ID("recordType")
				run.Expect.CIs = append(run.Expect.CIs, sim.ExpectCI{Type: typeRecord, Name: name, Identity: r.Identity})
				run.Expect.Rel("contains", typeZone, v.ci.Name, typeRecord, name)
				t := r.ID("recordType")
				if t != "A" && t != "AAAA" {
					continue
				}
				addr := net.ParseIP(r.ID("value")).String()
				run.Expect.RelToRef("resolves_to", typeRecord, name, typeIP, map[string]string{"address": addr})
				if seenIP[addr] {
					continue
				}
				seenIP[addr] = true
				if c := ips[addr]; c != nil {
					run.Expect.EstateCI(c)
				} else {
					run.Expect.CI(typeIP, addr)
				}
			}
		}
		runs = append(runs, run)
	}
	return runs
}
