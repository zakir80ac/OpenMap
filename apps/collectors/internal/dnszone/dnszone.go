// REQ-DISC-021 REQ-IPAM-003 — DNS zone collector: AXFR zone transfers (optionally TSIG-signed)
// from BIND, Windows DNS, Infoblox, PowerDNS, Knot and any RFC 5936 server; emits dns_zone and
// dns_record CIs, ip_address CIs for A/AAAA data and resolves_to relationships for IPAM.
// REQ-IPAM-003: with the `updates` option it first applies record changes OpenMap requested as one RFC 2136 UPDATE
// per zone (atomic, TSIG-signed), then transfers the zone, so the result shows the server's state after the change.
package dnszone

import (
	"context"
	"encoding/base64"
	"net"
	"strconv"
	"strings"
	"time"

	"github.com/miekg/dns"

	"github.com/openmap/openmap/apps/collectors/internal/collector"
	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

const (
	collectorID   = "dns"
	version       = "0.1.0"
	evidenceKind  = "cli_output"
	defaultPort   = 53
	dialTimeout   = 15 * time.Second
	optionPort    = "port"
	optionZones   = "zones"
	optionTsigKey = "tsigKeyName"
	optionTsigAlg = "tsigAlgorithm" // hmac-sha256 (default), hmac-sha512, hmac-sha1
	optionUpdates = "updates"       // [{zone, op: add|delete, name, type, value, ttl}]
	opAdd         = "add"
	opDelete      = "delete"
	defaultTTL    = 3600
	tsigFudge     = 300
	credSecret    = "token"
	defaultTsig   = dns.HmacSHA256
	defaultVrf    = "default"

	typeZone      = "dns_zone"
	typeRecord    = "dns_record"
	typeIP        = "ip_address"
	relContains   = "contains"
	relResolvesTo = "resolves_to"
)

type Collector struct{}

func (Collector) Manifest() contract.Manifest {
	return contract.Manifest{
		ID: collectorID, Family: "dns", Version: version, Language: "go",
		Protocols: []string{"dns-axfr"}, CredentialTypes: []string{"none", "api_token"},
		TargetKinds: []string{"host"}, Emits: []string{typeZone, typeRecord, typeIP},
		ContractVersion: contract.Version,
	}
}

// Zone is one transferred zone.
type Zone struct {
	Name    string
	Serial  uint32
	Records []dns.RR
	Text    string
}

// TSIG holds the signing key for authenticated transfers.
type TSIG struct {
	Name      string
	Algorithm string
	Secret    string // base64
}

// Transfer runs AXFR for one zone against server (host:port).
func Transfer(ctx context.Context, server, zone string, tsig *TSIG) (*Zone, error) {
	fqdn := dns.Fqdn(zone)
	m := new(dns.Msg)
	m.SetAxfr(fqdn)
	t := &dns.Transfer{DialTimeout: dialTimeout, ReadTimeout: dialTimeout, WriteTimeout: dialTimeout}
	if tsig != nil {
		keyName := dns.Fqdn(tsig.Name)
		alg := dns.Fqdn(strings.ToLower(firstNonEmpty(tsig.Algorithm, defaultTsig)))
		t.TsigSecret = map[string]string{keyName: tsig.Secret}
		m.SetTsig(keyName, alg, 300, time.Now().Unix())
	}
	done := make(chan struct{})
	var env chan *dns.Envelope
	var err error
	go func() {
		env, err = t.In(m, server)
		close(done)
	}()
	select {
	case <-ctx.Done():
		return nil, collector.Errorf(contract.ErrTimeout, true, "%s: zone transfer of %s timed out", server, zone)
	case <-done:
	}
	if err != nil {
		return nil, classify(server, zone, err)
	}
	z := &Zone{Name: strings.TrimSuffix(fqdn, ".")}
	var text strings.Builder
	for e := range env {
		if e.Error != nil {
			return nil, classify(server, zone, e.Error)
		}
		for _, rr := range e.RR {
			if soa, ok := rr.(*dns.SOA); ok && z.Serial == 0 {
				z.Serial = soa.Serial
			}
			z.Records = append(z.Records, rr)
			text.WriteString(rr.String())
			text.WriteByte('\n')
		}
	}
	if len(z.Records) == 0 {
		return nil, collector.Errorf(contract.ErrPermissionDenied, false, "%s returned an empty transfer for %s (AXFR refused?)", server, zone)
	}
	z.Text = text.String()
	return z, nil
}

// Change is one record change to apply: added, or removed (that exact record).
type Change struct {
	Zone  string
	Op    string
	Name  string
	Type  string
	Value string
	TTL   uint32
}

// Changes reads the `updates` option; an entry missing a field it needs is an error, not skipped.
func Changes(options map[string]any) ([]Change, error) {
	list, ok := options[optionUpdates].([]any)
	if !ok {
		return nil, nil
	}
	out := make([]Change, 0, len(list))
	for i, item := range list {
		m, ok := item.(map[string]any)
		if !ok {
			return nil, collector.Errorf(contract.ErrInternal, false, "update %d is not an object", i)
		}
		str := func(k string) string { v, _ := m[k].(string); return strings.TrimSpace(v) }
		c := Change{Zone: str("zone"), Op: str("op"), Name: str("name"), Type: strings.ToUpper(str("type")), Value: str("value"), TTL: defaultTTL}
		if ttl, ok := m["ttl"].(float64); ok && ttl > 0 {
			c.TTL = uint32(ttl)
		}
		if c.Zone == "" || c.Name == "" || c.Type == "" || c.Value == "" || (c.Op != opAdd && c.Op != opDelete) {
			return nil, collector.Errorf(contract.ErrInternal, false, "update %d needs zone, op (add or delete), name, type and value", i)
		}
		out = append(out, c)
	}
	return out, nil
}

// fqdnIn makes a record name absolute within its zone: "www" and "www.corp.example" are the same name.
func fqdnIn(name, zone string) string {
	n := strings.TrimSuffix(strings.ToLower(name), ".")
	z := strings.TrimSuffix(strings.ToLower(zone), ".")
	if n == "@" || n == z {
		return z + "."
	}
	if strings.HasSuffix(n, "."+z) {
		return n + "."
	}
	return n + "." + z + "."
}

// Update applies one zone's changes as a single RFC 2136 UPDATE: the server applies all of them or none.
func Update(ctx context.Context, server, zone string, changes []Change, tsig *TSIG) error {
	if len(changes) == 0 {
		return nil
	}
	m := new(dns.Msg)
	m.SetUpdate(dns.Fqdn(zone))
	var add, remove []dns.RR
	for _, c := range changes {
		rr, err := dns.NewRR(fqdnIn(c.Name, zone) + " " + strconv.FormatUint(uint64(c.TTL), 10) + " IN " + c.Type + " " + c.Value)
		if err != nil {
			return collector.Errorf(contract.ErrInternal, false, "%s %s %s is not a valid record: %v", c.Name, c.Type, c.Value, err)
		}
		if c.Op == opAdd {
			add = append(add, rr)
		} else {
			remove = append(remove, rr)
		}
	}
	if len(remove) > 0 {
		m.Remove(remove)
	}
	if len(add) > 0 {
		m.Insert(add)
	}
	client := &dns.Client{Net: "tcp", DialTimeout: dialTimeout, ReadTimeout: dialTimeout, WriteTimeout: dialTimeout}
	if tsig != nil {
		keyName := dns.Fqdn(tsig.Name)
		client.TsigSecret = map[string]string{keyName: tsig.Secret}
		m.SetTsig(keyName, dns.Fqdn(strings.ToLower(firstNonEmpty(tsig.Algorithm, defaultTsig))), tsigFudge, time.Now().Unix())
	}
	reply, _, err := client.ExchangeContext(ctx, m, server)
	if err != nil {
		return classify(server, zone, err)
	}
	switch reply.Rcode {
	case dns.RcodeSuccess:
		return nil
	case dns.RcodeRefused, dns.RcodeNotAuth, dns.RcodeBadSig:
		return collector.Errorf(contract.ErrPermissionDenied, false, "%s refused the update of %s: %s", server, zone, dns.RcodeToString[reply.Rcode])
	default:
		return collector.Errorf(contract.ErrInternal, false, "%s rejected the update of %s: %s", server, zone, dns.RcodeToString[reply.Rcode])
	}
}

func classify(server, zone string, err error) error {
	msg := strings.ToLower(err.Error())
	switch {
	case strings.Contains(msg, "refused") || strings.Contains(msg, "notauth") || strings.Contains(msg, "bad authentication") || strings.Contains(msg, "bad") && strings.Contains(msg, "tsig"):
		return collector.Errorf(contract.ErrPermissionDenied, false, "%s refused %s (check the TSIG key): %v", server, zone, err)
	case strings.Contains(msg, "timeout") || strings.Contains(msg, "i/o"):
		return collector.Errorf(contract.ErrTimeout, true, "%s: %v", server, err)
	default:
		return collector.Errorf(contract.ErrUnreachable, true, "%s (%s): %v", server, zone, err)
	}
}

func rdata(rr dns.RR) string {
	s := rr.String()
	// RR.String() renders "name\tttl\tclass\ttype\trdata"; the rdata is everything after the type.
	parts := strings.SplitN(s, "\t", 5)
	if len(parts) == 5 {
		return parts[4]
	}
	return s
}

// Emit converts zones into observations.
func Emit(zones []*Zone, server string, at time.Time) collector.Observation {
	obs := collector.Observation{}
	for _, z := range zones {
		obs.Evidence = append(obs.Evidence, collector.RawEvidence{Kind: evidenceKind, Data: []byte(z.Text)})
		zoneIdentity := map[string]string{"name": z.Name}
		zoneRef := contract.CiRef{Type: typeZone, Identity: zoneIdentity}
		counts := map[string]int{}
		seenRecord := map[string]bool{}
		var records []contract.ObservedCi
		for _, rr := range z.Records {
			rtype := dns.TypeToString[rr.Header().Rrtype]
			if rtype == "SOA" && seenRecord["SOA"] {
				continue // AXFR closes with a second SOA
			}
			seenRecord["SOA"] = seenRecord["SOA"] || rtype == "SOA"
			name := strings.TrimSuffix(strings.ToLower(rr.Header().Name), ".")
			value := rdata(rr)
			key := rtype + "|" + name + "|" + value
			if seenRecord[key] {
				continue
			}
			seenRecord[key] = true
			counts[rtype]++
			identity := map[string]string{"zoneRef": z.Name, "name": name, "recordType": rtype, "value": value}
			ref := contract.CiRef{Type: typeRecord, Identity: identity}
			records = append(records, contract.ObservedCi{Type: typeRecord, Identity: identity, Name: name + " " + rtype,
				Attributes: map[string]any{"zone": z.Name, "recordType": rtype, "value": value, "ttl": rr.Header().Ttl, "server": server},
				Tags:       []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
			obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relContains, From: zoneRef, To: ref, Attributes: map[string]any{}, ObservedAt: at})
			var ip net.IP
			switch r := rr.(type) {
			case *dns.A:
				ip = r.A
			case *dns.AAAA:
				ip = r.AAAA
			}
			if ip != nil {
				ipIdentity := map[string]string{"address": ip.String(), "vrfRef": defaultVrf}
				obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeIP, Identity: ipIdentity, Name: ip.String(), Attributes: map[string]any{"dnsName": name, "zone": z.Name, "source": collectorID}, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
				obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relResolvesTo, From: ref, To: contract.CiRef{Type: typeIP, Identity: ipIdentity}, Attributes: map[string]any{}, ObservedAt: at})
			}
		}
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeZone, Identity: zoneIdentity, Name: z.Name,
			Attributes: map[string]any{"serial": z.Serial, "recordCount": len(records), "recordTypes": counts, "server": server, "transfer": "axfr"},
			Tags:       []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
		obs.Cis = append(obs.Cis, records...)
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
	zones := []string{}
	if list, ok := options[optionZones].([]any); ok {
		for _, z := range list {
			if s, ok := z.(string); ok && s != "" {
				zones = append(zones, s)
			}
		}
	}
	if len(zones) == 0 {
		return collector.Observation{}, collector.Errorf(contract.ErrInternal, false, "dns job names no zones to transfer")
	}
	port := defaultPort
	if p, ok := options[optionPort].(float64); ok && p > 0 {
		port = int(p)
	}
	server := net.JoinHostPort(target.Value, strconv.Itoa(port))
	var tsig *TSIG
	if cred != nil && cred.Type == "api_token" && cred.Fields[credSecret] != "" {
		if _, err := base64.StdEncoding.DecodeString(cred.Fields[credSecret]); err != nil {
			return collector.Observation{}, collector.Errorf(contract.ErrAuthFailed, false, "TSIG secret is not base64")
		}
		keyName, _ := options[optionTsigKey].(string)
		alg, _ := options[optionTsigAlg].(string)
		tsig = &TSIG{Name: keyName, Algorithm: alg, Secret: cred.Fields[credSecret]}
	}
	changes, err := Changes(options)
	if err != nil {
		return collector.Observation{}, err
	}
	byZone := map[string][]Change{}
	for _, c := range changes {
		key := strings.TrimSuffix(strings.ToLower(c.Zone), ".")
		byZone[key] = append(byZone[key], c)
	}
	// Changes go first, one atomic update per zone; a refused update fails the job, so no transfer can make a
	// change look applied.
	for _, z := range zones {
		if err := Update(ctx, server, z, byZone[strings.TrimSuffix(strings.ToLower(z), ".")], tsig); err != nil {
			return collector.Observation{}, err
		}
	}
	var out []*Zone
	var firstErr error
	for _, z := range zones {
		zone, err := Transfer(ctx, server, z, tsig)
		if err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		out = append(out, zone)
	}
	if len(out) == 0 {
		return collector.Observation{}, firstErr
	}
	return Emit(out, target.Value, time.Now().UTC()), nil
}
