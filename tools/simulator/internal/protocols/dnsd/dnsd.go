// REQ-QA-005 REQ-DISC-021 — an authoritative DNS server for simulated mode (github.com/miekg/dns): serves
// SOA over UDP and TCP and full zone transfers (AXFR, RFC 5936) over TCP on one loopback port, optionally
// requiring a TSIG-signed request (RFC 8945) the way BIND's `allow-transfer { key ...; }` and Infoblox's
// TSIG-based transfer ACLs do. A Flavour carries what differs between products on the wire: SOA naming and
// timers, how many records each transfer message packs, whether TSIG is required and the version.bind answer.
package dnsd

import (
	"net"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/miekg/dns"
)

// Flavour is one DNS product's observable behaviour.
type Flavour struct {
	Name string
	// MName / RName are the SOA primary server and responsible mailbox (both FQDNs).
	MName, RName                    string
	Refresh, Retry, Expire, Minimum uint32
	// RecordsPerMessage bounds the RRs in one AXFR message (1 = one-answer format).
	RecordsPerMessage int
	// TSIGKey / TSIGAlgorithm name the key transfers must be signed with ("" = unsigned transfers allowed).
	TSIGKey, TSIGAlgorithm string
	// Version answers CHAOS TXT version.bind ("" refuses the query, as Windows DNS and hidden-version BIND do).
	Version string
}

// Zone is one authoritative zone: the SOA is built from the flavour; Records follow it in transfer order.
type Zone struct {
	Name    string
	Serial  uint32
	TTL     uint32
	Records []dns.RR
}

// Server is a running authoritative server.
type Server struct {
	Addr string
	Port int
	tcp  *dns.Server
	udp  *dns.Server
	// Transfers counts completed AXFRs (signed or not) for diagnostics.
	Transfers atomic.Int64
}

func (f Flavour) soa(z Zone) *dns.SOA {
	return &dns.SOA{
		Hdr: dns.RR_Header{Name: dns.Fqdn(z.Name), Rrtype: dns.TypeSOA, Class: dns.ClassINET, Ttl: z.TTL},
		Ns:  dns.Fqdn(f.MName), Mbox: dns.Fqdn(f.RName), Serial: z.Serial,
		Refresh: f.Refresh, Retry: f.Retry, Expire: f.Expire, Minttl: f.Minimum,
	}
}

func reply(w dns.ResponseWriter, r *dns.Msg, rcode int) {
	m := new(dns.Msg)
	m.SetRcode(r, rcode)
	if t := r.IsTsig(); t != nil && w.TsigStatus() == nil {
		m.SetTsig(t.Hdr.Name, t.Algorithm, t.Fudge, time.Now().Unix())
	}
	_ = w.WriteMsg(m)
}

// handler answers for the zones it is authoritative for.
func (s *Server) handler(f Flavour, zones []Zone, tcp bool) dns.HandlerFunc {
	byName := map[string]Zone{}
	for _, z := range zones {
		byName[strings.ToLower(dns.Fqdn(z.Name))] = z
	}
	return func(w dns.ResponseWriter, r *dns.Msg) {
		if len(r.Question) != 1 {
			reply(w, r, dns.RcodeFormatError)
			return
		}
		q := r.Question[0]
		if q.Qclass == dns.ClassCHAOS && q.Qtype == dns.TypeTXT && strings.EqualFold(q.Name, "version.bind.") {
			if f.Version == "" {
				reply(w, r, dns.RcodeRefused)
				return
			}
			m := new(dns.Msg)
			m.SetReply(r)
			m.Answer = []dns.RR{&dns.TXT{Hdr: dns.RR_Header{Name: q.Name, Rrtype: dns.TypeTXT, Class: dns.ClassCHAOS}, Txt: []string{f.Version}}}
			_ = w.WriteMsg(m)
			return
		}
		z, ok := byName[strings.ToLower(q.Name)]
		if !ok {
			reply(w, r, dns.RcodeRefused) // not authoritative, recursion not offered
			return
		}
		switch q.Qtype {
		case dns.TypeAXFR:
			s.transfer(w, r, f, z, tcp)
		case dns.TypeSOA:
			m := new(dns.Msg)
			m.SetReply(r)
			m.Authoritative = true
			m.Answer = []dns.RR{f.soa(z)}
			_ = w.WriteMsg(m)
		default:
			m := new(dns.Msg)
			m.SetReply(r)
			m.Authoritative = true
			for _, rr := range z.Records {
				if rr.Header().Rrtype == q.Qtype && strings.EqualFold(rr.Header().Name, q.Name) {
					m.Answer = append(m.Answer, rr)
				}
			}
			if len(m.Answer) == 0 {
				m.Ns = []dns.RR{f.soa(z)}
			}
			_ = w.WriteMsg(m)
		}
	}
}

func (s *Server) transfer(w dns.ResponseWriter, r *dns.Msg, f Flavour, z Zone, tcp bool) {
	if !tcp {
		reply(w, r, dns.RcodeRefused) // AXFR is TCP only (RFC 5936 §4.2)
		return
	}
	if f.TSIGKey != "" {
		t := r.IsTsig()
		switch {
		case t == nil:
			reply(w, r, dns.RcodeRefused) // transfer ACL names a key; unsigned requests are denied
			return
		case w.TsigStatus() != nil || !strings.EqualFold(t.Hdr.Name, dns.Fqdn(f.TSIGKey)) || !strings.EqualFold(t.Algorithm, dns.Fqdn(f.TSIGAlgorithm)):
			reply(w, r, dns.RcodeNotAuth)
			return
		}
	}
	soa := f.soa(z)
	all := make([]dns.RR, 0, len(z.Records)+2)
	all = append(all, soa)
	all = append(all, z.Records...)
	all = append(all, soa)
	per := max(f.RecordsPerMessage, 1)
	ch := make(chan *dns.Envelope)
	tr := new(dns.Transfer)
	go func() {
		defer close(ch)
		for i := 0; i < len(all); i += per {
			ch <- &dns.Envelope{RR: all[i:min(i+per, len(all))]}
		}
	}()
	if err := tr.Out(w, r, ch); err == nil {
		s.Transfers.Add(1)
	}
	for range ch {
	}
	_ = w.Close()
}

// Serve starts the flavour's server on a TCP listener and a UDP socket bound to the same address and port
// (the caller opens the listener; Serve binds UDP next to it). secrets maps TSIG key FQDNs to base64.
func Serve(f Flavour, zones []Zone, secrets map[string]string, ln net.Listener) (*Server, error) {
	tcpAddr := ln.Addr().(*net.TCPAddr)
	pc, err := net.ListenPacket("udp", net.JoinHostPort(tcpAddr.IP.String(), strconv.Itoa(tcpAddr.Port)))
	if err != nil {
		_ = ln.Close()
		return nil, err
	}
	s := &Server{Addr: ln.Addr().String(), Port: tcpAddr.Port}
	s.tcp = &dns.Server{Listener: ln, Handler: s.handler(f, zones, true), TsigSecret: secrets}
	s.udp = &dns.Server{PacketConn: pc, Handler: s.handler(f, zones, false), TsigSecret: secrets}
	started := make(chan struct{}, 2)
	s.tcp.NotifyStartedFunc = func() { started <- struct{}{} }
	s.udp.NotifyStartedFunc = func() { started <- struct{}{} }
	go func() { _ = s.tcp.ActivateAndServe() }()
	go func() { _ = s.udp.ActivateAndServe() }()
	<-started
	<-started
	return s, nil
}

// Close stops both listeners.
func (s *Server) Close() error {
	err := s.tcp.Shutdown()
	if uerr := s.udp.Shutdown(); err == nil {
		err = uerr
	}
	return err
}
