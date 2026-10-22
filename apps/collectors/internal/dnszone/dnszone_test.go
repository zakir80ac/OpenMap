// T-043 REQ-DISC-021 — serves a zone over AXFR from an in-process DNS server (TCP on loopback) and
// checks the transferred records, A/AAAA address CIs and resolves_to relationships.
package dnszone

import (
	"context"
	"net"
	"testing"
	"time"

	"github.com/miekg/dns"
)

const zoneText = `$ORIGIN corp.example.
$TTL 3600
@        IN SOA ns1.corp.example. hostmaster.corp.example. 2026102201 7200 3600 1209600 3600
@        IN NS  ns1.corp.example.
ns1      IN A   10.0.0.53
www      IN A   10.0.0.80
www      IN AAAA 2001:db8::80
api      IN CNAME www.corp.example.
_sip._tcp IN SRV 10 60 5060 sip.corp.example.
sip      IN A   10.0.0.60
`

func startServer(t *testing.T) string {
	t.Helper()
	var rrs []dns.RR
	zp := dns.NewZoneParser(nil, "corp.example.", "")
	_ = zp
	for rr, ok := firstRR(t); ok; rr, ok = nextRR() {
		rrs = append(rrs, rr)
	}
	mux := dns.NewServeMux()
	mux.HandleFunc("corp.example.", func(w dns.ResponseWriter, r *dns.Msg) {
		if r.Question[0].Qtype != dns.TypeAXFR {
			m := new(dns.Msg)
			m.SetRcode(r, dns.RcodeRefused)
			_ = w.WriteMsg(m)
			return
		}
		tr := new(dns.Transfer)
		ch := make(chan *dns.Envelope)
		go func() {
			ch <- &dns.Envelope{RR: append(append([]dns.RR{}, rrs...), rrs[0])}
			close(ch)
		}()
		_ = tr.Out(w, r, ch)
	})
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	srv := &dns.Server{Listener: ln, Handler: mux}
	go func() { _ = srv.ActivateAndServe() }()
	t.Cleanup(func() { _ = srv.Shutdown() })
	return ln.Addr().String()
}

var parsed []dns.RR
var cursor int

func firstRR(t *testing.T) (dns.RR, bool) {
	t.Helper()
	parsed = nil
	cursor = 0
	zp := dns.NewZoneParser(stringsReader(zoneText), "corp.example.", "")
	for rr, ok := zp.Next(); ok; rr, ok = zp.Next() {
		parsed = append(parsed, rr)
	}
	if err := zp.Err(); err != nil {
		t.Fatal(err)
	}
	return nextRR()
}

func nextRR() (dns.RR, bool) {
	if cursor >= len(parsed) {
		return nil, false
	}
	rr := parsed[cursor]
	cursor++
	return rr, true
}

func TestTransferAndEmit(t *testing.T) {
	server := startServer(t)
	zone, err := Transfer(context.Background(), server, "corp.example", nil)
	if err != nil {
		t.Fatal(err)
	}
	if zone.Serial != 2026102201 || len(zone.Records) != 9 {
		t.Fatalf("zone wrong: serial=%d records=%d", zone.Serial, len(zone.Records))
	}
	obs := Emit([]*Zone{zone}, "127.0.0.1", time.Now())
	types := map[string]int{}
	for _, ci := range obs.Cis {
		types[ci.Type]++
	}
	if types[typeZone] != 1 || types[typeRecord] != 8 || types[typeIP] != 4 {
		t.Fatalf("unexpected CI mix: %+v", types)
	}
	rels := map[string]int{}
	for _, r := range obs.Relationships {
		rels[r.Type]++
	}
	if rels[relContains] != 8 || rels[relResolvesTo] != 4 {
		t.Fatalf("relationship mix wrong: %+v", rels)
	}
	for _, ci := range obs.Cis {
		if ci.Type == typeRecord && ci.Identity["recordType"] == "CNAME" && ci.Identity["value"] != "www.corp.example." {
			t.Fatalf("cname rdata wrong: %+v", ci.Identity)
		}
	}
}

func TestRefusedZone(t *testing.T) {
	server := startServer(t)
	_, err := Transfer(context.Background(), server, "other.example", nil)
	if err == nil {
		t.Fatal("expected refusal for an unserved zone")
	}
}
