// T-414 REQ-QA-005 REQ-DISC-021 — the simulated authoritative server refuses unsigned transfers when the
// flavour names a TSIG key, answers NOTAUTH for a request signed with the wrong key, and transfers the zone
// (SOA first and last) in the flavour's message framing when the request is signed correctly.
package dnsd

import (
	"encoding/base64"
	"net"
	"testing"
	"time"

	"github.com/miekg/dns"
)

const (
	testKey  = "xfr-key."
	testZone = "lab.example."
	fudge    = 300
)

func TestTransferRequiresTSIG(t *testing.T) {
	secret := base64.StdEncoding.EncodeToString([]byte("simulated-secret"))
	a, err := dns.NewRR("www.lab.example. 3600 IN A 192.0.2.10")
	if err != nil {
		t.Fatal(err)
	}
	f := Flavour{Name: "bind", MName: "ns1.lab.example", RName: "hostmaster.lab.example", Refresh: 7200, Retry: 3600, Expire: 1209600, Minimum: 3600,
		RecordsPerMessage: 1, TSIGKey: testKey, TSIGAlgorithm: dns.HmacSHA256}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	s, err := Serve(f, []Zone{{Name: testZone, Serial: 7, TTL: 3600, Records: []dns.RR{a}}}, map[string]string{testKey: secret}, ln)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	xfer := func(key, sec string) ([]*dns.Envelope, error) {
		m := new(dns.Msg)
		m.SetAxfr(testZone)
		tr := &dns.Transfer{}
		if key != "" {
			tr.TsigSecret = map[string]string{key: sec}
			m.SetTsig(key, dns.HmacSHA256, fudge, time.Now().Unix())
		}
		ch, err := tr.In(m, s.Addr)
		if err != nil {
			return nil, err
		}
		var out []*dns.Envelope
		for e := range ch {
			if e.Error != nil {
				return out, e.Error
			}
			out = append(out, e)
		}
		return out, nil
	}
	if _, err := xfer("", ""); err == nil {
		t.Fatal("unsigned transfer was allowed")
	}
	if _, err := xfer("other-key.", secret); err == nil {
		t.Fatal("transfer signed with an unknown key was allowed")
	}
	envs, err := xfer(testKey, secret)
	if err != nil {
		t.Fatal(err)
	}
	if len(envs) != 3 {
		t.Fatalf("one-answer framing: want 3 messages (SOA, A, SOA), got %d", len(envs))
	}
	if _, ok := envs[0].RR[0].(*dns.SOA); !ok {
		t.Fatalf("transfer does not open with the SOA: %v", envs[0].RR)
	}
	if s.Transfers.Load() != 1 {
		t.Fatalf("transfers counted %d", s.Transfers.Load())
	}
}
