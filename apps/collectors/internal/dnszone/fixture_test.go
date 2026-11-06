// T-309 REQ-DISC-021 — recorded vendor fixtures: AXFR wire streams captured from real BIND 9, Knot DNS
// and PowerDNS Authoritative servers in the container lab (packages/testing/fixtures/vendor/dns). A
// loopback TCP server replays each server's recorded length-prefixed messages, rewriting only the
// DNS message ID to the one the client chose (the protocol requires the echo), so the collector's
// real Transfer and Emit run over the vendor's bytes.
package dnszone

import (
	"bytes"
	"context"
	"encoding/binary"
	"io"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

const fxDNSFamilyDir = "../../../../packages/testing/fixtures/vendor/dns"

type fxZoneExpect struct {
	zone      string
	serial    uint32
	records   int            // unique records Emit keeps (closing SOA dropped)
	types     map[string]int // per-type counts
	ips       int            // ip_address CIs (A + AAAA)
	mustValue map[string]string
}

var fxLabZones = []fxZoneExpect{
	{
		zone: "lab.openmap.test", serial: 2026110601, records: 14,
		types: map[string]int{"SOA": 1, "NS": 1, "MX": 1, "TXT": 1, "A": 7, "AAAA": 1, "CNAME": 1, "SRV": 1},
		ips:   8,
		mustValue: map[string]string{
			"A|www.lab.openmap.test":          "10.250.70.80",
			"AAAA|www.lab.openmap.test":       "2001:db8:250:70::80",
			"CNAME|api.lab.openmap.test":      "www.lab.openmap.test.",
			"MX|lab.openmap.test":             "10 mail.lab.openmap.test.",
			"TXT|lab.openmap.test":            `"v=spf1 mx -all"`,
			"SRV|_ldap._tcp.lab.openmap.test": "0 100 389 dc01.lab.openmap.test.",
		},
	},
	{
		zone: "70.250.10.in-addr.arpa", serial: 2026110601, records: 9,
		types: map[string]int{"SOA": 1, "NS": 1, "PTR": 7},
		ips:   0,
		mustValue: map[string]string{
			"PTR|80.70.250.10.in-addr.arpa": "www.lab.openmap.test.",
			"PTR|10.70.250.10.in-addr.arpa": "dc01.lab.openmap.test.",
		},
	},
}

// Every recorded server directory must have a row here.
var fxDNSFixtures = map[string]string{
	"isc-bind-9.20.30":              "BIND 9.20.30",
	"cznic-knot-3.4.11":             "Knot DNS 3.4.11",
	"powerdns-authoritative-4.9.18": "PowerDNS Authoritative 4.9.18",
}

func fxSplitTCPMessages(t *testing.T, stream []byte) [][]byte {
	t.Helper()
	var out [][]byte
	for len(stream) > 0 {
		if len(stream) < 2 {
			t.Fatalf("trailing %d bytes in recorded stream", len(stream))
		}
		n := int(binary.BigEndian.Uint16(stream))
		if len(stream) < 2+n {
			t.Fatalf("truncated message: want %d bytes, have %d", n, len(stream)-2)
		}
		out = append(out, stream[2:2+n])
		stream = stream[2+n:]
	}
	return out
}

// fxReplayAXFR serves one AXFR from recorded server messages and returns host:port plus a channel
// carrying the query the collector sent.
func fxReplayAXFR(t *testing.T, messages [][]byte) (string, <-chan []byte) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	queries := make(chan []byte, 1)
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		var lenBuf [2]byte
		if _, err := io.ReadFull(conn, lenBuf[:]); err != nil {
			return
		}
		q := make([]byte, binary.BigEndian.Uint16(lenBuf[:]))
		if _, err := io.ReadFull(conn, q); err != nil {
			return
		}
		queries <- q
		for _, m := range messages {
			msg := append([]byte(nil), m...)
			copy(msg[:2], q[:2]) // echo the client's message ID
			frame := make([]byte, 2+len(msg))
			binary.BigEndian.PutUint16(frame, uint16(len(msg)))
			copy(frame[2:], msg)
			if _, err := conn.Write(frame); err != nil {
				return
			}
		}
	}()
	return ln.Addr().String(), queries
}

func TestREQDISC021_T309_RecordedVendorFixtures(t *testing.T) {
	dirs, err := os.ReadDir(fxDNSFamilyDir)
	if err != nil {
		t.Fatalf("fixture family dir: %v", err)
	}
	seen := 0
	for _, d := range dirs {
		if !d.IsDir() {
			continue
		}
		label, ok := fxDNSFixtures[d.Name()]
		if !ok {
			t.Errorf("fixture %s has no expectation row", d.Name())
			continue
		}
		seen++
		dir := filepath.Join(fxDNSFamilyDir, d.Name())
		t.Run(d.Name(), func(t *testing.T) {
			if _, err := os.Stat(filepath.Join(dir, "manifest.json")); err != nil {
				t.Fatalf("manifest: %v", err)
			}
			var zones []*Zone
			for _, want := range fxLabZones {
				server, err := os.ReadFile(filepath.Join(dir, "axfr-"+want.zone+".server.bin"))
				if err != nil {
					t.Fatal(err)
				}
				client, err := os.ReadFile(filepath.Join(dir, "axfr-"+want.zone+".client.bin"))
				if err != nil {
					t.Fatal(err)
				}
				recordedQuery := fxSplitTCPMessages(t, client)
				addr, queries := fxReplayAXFR(t, fxSplitTCPMessages(t, server))
				ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
				z, err := Transfer(ctx, addr, want.zone, nil)
				cancel()
				if err != nil {
					t.Fatalf("%s %s: %v", label, want.zone, err)
				}
				// The query the collector sends today must match the one recorded (ID aside).
				q := <-queries
				if len(recordedQuery) != 1 || !bytes.Equal(q[2:], recordedQuery[0][2:]) {
					t.Errorf("%s: collector query differs from the recorded one", want.zone)
				}
				if z.Serial != want.serial {
					t.Errorf("%s serial = %d, want %d", want.zone, z.Serial, want.serial)
				}
				zones = append(zones, z)
			}
			obs := Emit(zones, "10.250.70.53", time.Now())
			for i, want := range fxLabZones {
				var zoneCI *contract.ObservedCi
				values := map[string]string{}
				ips := 0
				for j := range obs.Cis {
					c := &obs.Cis[j]
					switch {
					case c.Type == typeZone && c.Identity["name"] == want.zone:
						zoneCI = c
					case c.Type == typeRecord && c.Identity["zoneRef"] == want.zone:
						values[c.Identity["recordType"]+"|"+c.Identity["name"]] = c.Identity["value"]
					case c.Type == typeIP && c.Attributes["zone"] == want.zone:
						ips++
					}
				}
				if zoneCI == nil {
					t.Fatalf("no dns_zone CI for %s", want.zone)
				}
				if got := zoneCI.Attributes["recordCount"]; got != want.records {
					t.Errorf("%s recordCount = %v, want %d", want.zone, got, want.records)
				}
				counts, _ := zoneCI.Attributes["recordTypes"].(map[string]int)
				for typ, n := range want.types {
					if counts[typ] != n {
						t.Errorf("%s %s records = %d, want %d (all %v)", want.zone, typ, counts[typ], n, counts)
					}
				}
				if ips != want.ips {
					t.Errorf("%s ip_address CIs = %d, want %d", want.zone, ips, want.ips)
				}
				for key, v := range want.mustValue {
					if values[key] != v {
						t.Errorf("%s %s = %q, want %q", want.zone, key, values[key], v)
					}
				}
				if len(obs.Evidence) != len(fxLabZones) || len(obs.Evidence[i].Data) == 0 {
					t.Errorf("evidence per zone missing")
				}
			}
			contains, resolves := 0, 0
			for _, r := range obs.Relationships {
				switch r.Type {
				case relContains:
					contains++
				case relResolvesTo:
					resolves++
					if r.To.Type != typeIP || r.From.Type != typeRecord {
						t.Errorf("resolves_to %s -> %s", r.From.Type, r.To.Type)
					}
				}
			}
			if contains != 14+9 || resolves != 8 {
				t.Errorf("contains=%d resolves_to=%d, want 23 and 8", contains, resolves)
			}
		})
	}
	if seen == 0 {
		t.Fatal("no recorded DNS fixtures found")
	}
}
