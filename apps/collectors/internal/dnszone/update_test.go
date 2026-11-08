// T-513 REQ-IPAM-003 — record changes pushed to a DNS server: an in-process authoritative server (TCP on loopback)
// that requires TSIG, applies RFC 2136 updates to its zone and serves it over AXFR. Collect with the `updates` option
// adds and removes records in one atomic update and returns the zone as the server now holds it; a wrong key is
// refused and nothing is transferred; a malformed change is an error before anything is sent.
package dnszone

import (
	"context"
	"encoding/base64"
	"net"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/miekg/dns"

	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

const (
	updateZone   = "lab.example."
	updateKey    = "openmap-sync."
	updateSecret = "c2VjcmV0LWtleS1mb3ItdGVzdHMtb25seS0xMjM0NTY="
)

const updateZoneText = `$ORIGIN lab.example.
$TTL 3600
@     IN SOA ns1.lab.example. hostmaster.lab.example. 1 7200 3600 1209600 3600
@     IN NS  ns1.lab.example.
ns1   IN A   10.9.0.53
www   IN A   10.9.0.80
`

type updateServer struct {
	mu  sync.Mutex
	rrs []dns.RR
}

func sameRR(a, b dns.RR) bool {
	ha, hb := a.Header(), b.Header()
	return strings.EqualFold(ha.Name, hb.Name) && ha.Rrtype == hb.Rrtype && rdata(a) == rdata(b)
}

func (s *updateServer) handle(w dns.ResponseWriter, r *dns.Msg) {
	reply := new(dns.Msg)
	reply.SetReply(r)
	signed := r.IsTsig() != nil
	if !signed || w.TsigStatus() != nil {
		reply.SetRcode(r, dns.RcodeNotAuth)
	} else if r.Opcode == dns.OpcodeUpdate {
		s.mu.Lock()
		for _, rr := range r.Ns {
			if rr.Header().Class == dns.ClassNONE {
				kept := s.rrs[:0]
				for _, have := range s.rrs {
					probe := dns.Copy(rr)
					probe.Header().Class = dns.ClassINET
					if !sameRR(have, probe) {
						kept = append(kept, have)
					}
				}
				s.rrs = kept
			} else {
				s.rrs = append(s.rrs, rr)
			}
		}
		s.mu.Unlock()
	} else if len(r.Question) > 0 && r.Question[0].Qtype == dns.TypeAXFR {
		s.mu.Lock()
		out := append(append([]dns.RR{}, s.rrs...), s.rrs[0])
		s.mu.Unlock()
		ch := make(chan *dns.Envelope, 1)
		ch <- &dns.Envelope{RR: out}
		close(ch)
		tr := new(dns.Transfer)
		tr.TsigSecret = map[string]string{updateKey: updateSecret}
		_ = tr.Out(w, r, ch)
		return
	}
	if signed {
		reply.SetTsig(updateKey, dns.HmacSHA256, tsigFudge, int64(r.IsTsig().TimeSigned))
	}
	_ = w.WriteMsg(reply)
}

func startUpdateServer(t *testing.T) (host string, port int) {
	t.Helper()
	s := &updateServer{}
	zp := dns.NewZoneParser(strings.NewReader(updateZoneText), updateZone, "")
	for rr, ok := zp.Next(); ok; rr, ok = zp.Next() {
		s.rrs = append(s.rrs, rr)
	}
	if err := zp.Err(); err != nil {
		t.Fatal(err)
	}
	mux := dns.NewServeMux()
	mux.HandleFunc(updateZone, s.handle)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	// The default accept function answers UPDATE with NOTIMP; an authoritative server for dynamic zones accepts it.
	accept := func(dns.Header) dns.MsgAcceptAction { return dns.MsgAccept }
	srv := &dns.Server{Listener: ln, Handler: mux, TsigSecret: map[string]string{updateKey: updateSecret}, MsgAcceptFunc: accept}
	go func() { _ = srv.ActivateAndServe() }()
	t.Cleanup(func() { _ = srv.Shutdown() })
	addr := ln.Addr().(*net.TCPAddr)
	return addr.IP.String(), addr.Port
}

func options(port int, updates []any) map[string]any {
	return map[string]any{
		optionZones: []any{"lab.example"}, optionPort: float64(port), optionTsigKey: updateKey, optionUpdates: updates,
	}
}

func cred(secret string) *contract.Credential {
	return &contract.Credential{Type: "api_token", Fields: map[string]string{credSecret: secret}}
}

func records(t *testing.T, cis []contract.ObservedCi) map[string]bool {
	t.Helper()
	out := map[string]bool{}
	for _, ci := range cis {
		if ci.Type == typeRecord {
			out[ci.Identity["name"]+" "+ci.Identity["recordType"]+" "+ci.Identity["value"]] = true
		}
	}
	return out
}

func TestUpdateThenTransfer(t *testing.T) {
	host, port := startUpdateServer(t)
	updates := []any{
		map[string]any{"zone": "lab.example", "op": "add", "name": "api", "type": "A", "value": "10.9.0.81", "ttl": float64(600)},
		map[string]any{"zone": "lab.example", "op": "delete", "name": "www.lab.example", "type": "A", "value": "10.9.0.80"},
	}
	obs, err := Collector{}.Collect(context.Background(), contract.Target{Kind: "host", Value: host}, cred(updateSecret), options(port, updates))
	if err != nil {
		t.Fatal(err)
	}
	got := records(t, obs.Cis)
	if !got["api.lab.example A 10.9.0.81"] {
		t.Fatalf("added record missing from the transfer: %v", got)
	}
	if got["www.lab.example A 10.9.0.80"] {
		t.Fatalf("deleted record still in the transfer: %v", got)
	}
	if !got["ns1.lab.example A 10.9.0.53"] {
		t.Fatalf("untouched record lost: %v", got)
	}
}

func TestUpdateRefusedWithWrongKey(t *testing.T) {
	host, port := startUpdateServer(t)
	wrong := base64.StdEncoding.EncodeToString([]byte("not-the-key-at-all-0000000000000"))
	updates := []any{map[string]any{"zone": "lab.example", "op": "add", "name": "api", "type": "A", "value": "10.9.0.81"}}
	_, err := Collector{}.Collect(context.Background(), contract.Target{Kind: "host", Value: host}, cred(wrong), options(port, updates))
	if err == nil {
		t.Fatal("an update signed with the wrong key must fail")
	}
	if !strings.Contains(err.Error(), "lab.example") {
		t.Fatalf("error should name the zone: %v", err)
	}
}

func TestMalformedChange(t *testing.T) {
	_, err := Changes(map[string]any{optionUpdates: []any{map[string]any{"zone": "lab.example", "op": "rename", "name": "a", "type": "A", "value": "1.2.3.4"}}})
	if err == nil {
		t.Fatal("an unknown op must be an error")
	}
	if err := Update(context.Background(), "127.0.0.1:"+strconv.Itoa(1), "lab.example", []Change{{Zone: "lab.example", Op: opAdd, Name: "a", Type: "A", Value: "not-an-address", TTL: defaultTTL}}, nil); err == nil {
		t.Fatal("a record that does not parse must be an error before anything is sent")
	}
	if fqdnIn("www", "lab.example") != "www.lab.example." || fqdnIn("www.lab.example.", "lab.example") != "www.lab.example." || fqdnIn("@", "lab.example") != "lab.example." {
		t.Fatal("record names must resolve within the zone")
	}
}
