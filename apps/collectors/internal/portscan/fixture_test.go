// T-308 REQ-DISC-020 — recorded vendor fixtures: the raw bytes real services sent to a capture that
// performs Probe's exact socket IO (one banner read, HEAD on HTTP ports, TLS handshake on TLS ports)
// in the container lab are replayed from local TCP listeners. Banner services go through the real
// Probe (dial, readBanner, printable, Classify); HTTP replies through readBanner after the same HEAD
// request; TLS leaf certificates through tlsName; then Emit. Fixtures live in
// packages/testing/fixtures/vendor/port_scan.
package portscan

import (
	"bufio"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"io"
	"net"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"
)

const portFixtureRoot = "../../../../packages/testing/fixtures/vendor/port_scan"

const replayTimeout = 300 * time.Millisecond

type captureRecord struct {
	Host        string   `json:"host"`
	Port        int      `json:"port"`
	Mode        string   `json:"mode"`
	BannerFile  string   `json:"bannerFile"`
	BannerBytes int      `json:"bannerBytes"`
	TLS         bool     `json:"tls"`
	ChainFiles  []string `json:"chainFiles"`
}

// replayServer accepts connections and, per connection, optionally reads an HTTP request head and
// then writes the recorded bytes (or stays silent when there are none) before closing.
func replayServer(t *testing.T, reply []byte, readRequest bool, requests chan<- string) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				if readRequest {
					r := bufio.NewReader(c)
					var head strings.Builder
					for {
						line, err := r.ReadString('\n')
						head.WriteString(line)
						if err != nil || line == "\r\n" {
							break
						}
					}
					requests <- head.String()
				}
				if len(reply) == 0 {
					_ = c.SetReadDeadline(time.Now().Add(2 * replayTimeout))
					_, _ = io.Copy(io.Discard, c)
					return
				}
				_, _ = c.Write(reply)
			}(c)
		}
	}()
	return ln.Addr().(*net.TCPAddr).Port
}

type portExpect struct {
	service, product, version, tlsName string
	tls                                bool
}

type hostExpect struct {
	address        string
	classification string
	ports          map[int]portExpect
}

var portExpectations = map[string]hostExpect{
	"alpinelinux-linux-host-3.20": {address: "192.168.128.14", classification: "linux-host", ports: map[int]portExpect{
		21:  {service: "ftp", product: "vsFTPd"},
		22:  {service: "ssh", product: "OpenSSH", version: "9.7"},
		23:  {service: "telnet"},
		25:  {service: "smtp", product: "Postfix"},
		110: {service: "pop3"},
		143: {service: "imap"},
	}},
	"nginx-nginx-1.31.8": {address: "192.168.128.13", classification: "web-endpoint", ports: map[int]portExpect{
		80:  {service: "http", product: "nginx/1.31.8"},
		443: {service: "https", product: "nginx/1.31.8", tls: true, tlsName: "fxlab-web.lab.openmap.test"},
	}},
	"apache-httpd-2.4.69": {address: "192.168.128.12", classification: "web-endpoint", ports: map[int]portExpect{
		80: {service: "http", product: "Apache/2.4.69 (Unix)"},
	}},
	"oracle-mysql-8.4.13":         {address: "192.168.128.8", classification: "database-server", ports: map[int]portExpect{3306: {service: "mysql", product: "8.4.13"}}},
	"mariadb-mariadb-11.8.9":      {address: "192.168.128.9", classification: "database-server", ports: map[int]portExpect{3306: {service: "mysql", product: "11.8.9-MariaDB-ubu2404"}}},
	"redis-redis-7.4.12":          {address: "192.168.128.10", classification: "database-server", ports: map[int]portExpect{6379: {service: "redis"}}},
	"postgresql-postgresql-17.11": {address: "192.168.128.11", classification: "database-server", ports: map[int]portExpect{5432: {service: "postgresql"}}},
}

func replayPort(t *testing.T, dir string, rec captureRecord) Port {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(dir, rec.BannerFile))
	if err != nil {
		t.Fatal(err)
	}
	if len(raw) != rec.BannerBytes {
		t.Fatalf("%s: %d bytes on disk, capture recorded %d", rec.BannerFile, len(raw), rec.BannerBytes)
	}
	ctx := context.Background()
	switch rec.Mode {
	case "banner":
		port := replayServer(t, raw, false, nil)
		p := Probe(ctx, "127.0.0.1", port, replayTimeout, replayTimeout)
		if p == nil {
			t.Fatalf("replay of %s: port reported closed", rec.BannerFile)
		}
		// Re-key to the port the service was recorded on; classification falls back on it.
		p.Port, p.Service, p.Product, p.Version = rec.Port, "", "", ""
		Classify(p)
		return *p
	case "http", "tls+http":
		requests := make(chan string, 1)
		port := replayServer(t, raw, true, requests)
		conn, err := net.Dial("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
		if err != nil {
			t.Fatal(err)
		}
		request := "HEAD / HTTP/1.0\r\nHost: " + rec.Host + "\r\n\r\n" // what Probe writes on HTTP and TLS web ports
		if _, err := conn.Write([]byte(request)); err != nil {
			t.Fatal(err)
		}
		p := Port{Port: rec.Port, Banner: readBanner(conn, replayTimeout)}
		_ = conn.Close()
		if got := <-requests; got != request {
			t.Fatalf("replay server saw request %q", got)
		}
		if rec.Mode == "tls+http" {
			var chain []*x509.Certificate
			for _, f := range rec.ChainFiles {
				der, err := os.ReadFile(filepath.Join(dir, f))
				if err != nil {
					t.Fatal(err)
				}
				c, err := x509.ParseCertificate(der)
				if err != nil {
					t.Fatalf("%s: %v", f, err)
				}
				chain = append(chain, c)
			}
			p.TLS = true
			p.TLSName = tlsName(tls.ConnectionState{PeerCertificates: chain})
		}
		Classify(&p)
		return p
	default:
		t.Fatalf("unknown capture mode %q", rec.Mode)
		return Port{}
	}
}

func TestREQDISC020_T308_RecordedVendorFixtures(t *testing.T) {
	entries, err := os.ReadDir(portFixtureRoot)
	if err != nil {
		t.Fatalf("fixture root: %v", err)
	}
	dirs := 0
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		if _, portOnly := portOnlyExpectations[e.Name()]; portOnly {
			continue // T-321 replays these
		}
		dirs++
		exp, ok := portExpectations[e.Name()]
		if !ok {
			t.Errorf("fixture %s has no expectation row", e.Name())
			continue
		}
		t.Run(e.Name(), func(t *testing.T) {
			dir := filepath.Join(portFixtureRoot, e.Name())
			files, err := filepath.Glob(filepath.Join(dir, "*.json"))
			if err != nil || len(files) == 0 {
				t.Fatalf("no capture records in %s", dir)
			}
			var open []Port
			for _, f := range files {
				if filepath.Base(f) == "manifest.json" {
					continue
				}
				b, err := os.ReadFile(f)
				if err != nil {
					t.Fatal(err)
				}
				var rec captureRecord
				if err := json.Unmarshal(b, &rec); err != nil {
					t.Fatalf("%s: %v", f, err)
				}
				p := replayPort(t, dir, rec)
				want, ok := exp.ports[rec.Port]
				if !ok {
					t.Fatalf("capture of port %d has no expectation", rec.Port)
				}
				if p.Service != want.service || p.Product != want.product || p.Version != want.version || p.TLS != want.tls || p.TLSName != want.tlsName {
					t.Errorf("port %d: got service=%q product=%q version=%q tls=%v tlsName=%q, want %+v (banner %q)", rec.Port, p.Service, p.Product, p.Version, p.TLS, p.TLSName, want, p.Banner)
				}
				open = append(open, p)
			}
			if len(open) != len(exp.ports) {
				t.Fatalf("captured %d ports, expected %d", len(open), len(exp.ports))
			}
			sort.Slice(open, func(i, j int) bool { return open[i].Port < open[j].Port })
			obs := Emit(exp.address, "", open, time.Date(2026, 11, 6, 21, 9, 15, 0, time.UTC))
			host := obs.Cis[0]
			if host.Type != typeUnknown || host.Identity["address"] != exp.address || host.Attributes["classification"] != exp.classification || host.Attributes["openPorts"] != len(open) {
				t.Fatalf("host CI: %+v", host)
			}
			if obs.Cis[1].Type != typeIP || obs.Cis[1].Identity["address"] != exp.address || obs.Cis[1].Identity["vrfRef"] != defaultVrf {
				t.Fatalf("ip CI: %+v", obs.Cis[1])
			}
			listeners := map[string]map[string]any{}
			for _, ci := range obs.Cis[2:] {
				if ci.Type != typeListener || ci.Identity["hostRef"] != exp.address || ci.Identity["protocol"] != "tcp" {
					t.Fatalf("listener CI: %+v", ci)
				}
				listeners[ci.Identity["port"]] = ci.Attributes
			}
			for port, want := range exp.ports {
				got := listeners[strconv.Itoa(port)]
				if got == nil || got["service"] != want.service || got["product"] != want.product {
					t.Fatalf("listening_service %d: %+v", port, got)
				}
				if b, _ := got["banner"].(string); !jsonSafe(b) {
					t.Fatalf("listening_service %d banner is not printable text: %q", port, b)
				}
			}
			runsOn := 0
			for _, r := range obs.Relationships {
				if r.Type == relRunsOn && r.To.Identity["address"] == exp.address {
					runsOn++
				}
			}
			if runsOn != len(exp.ports) {
				t.Fatalf("runs_on relationships: %d", runsOn)
			}
		})
	}
	if dirs == 0 {
		t.Fatal("no recorded port_scan fixtures found")
	}
}

func jsonSafe(s string) bool {
	for _, r := range s {
		if r < ' ' && r != '\t' && r != '\n' && r != '\r' {
			return false
		}
	}
	return true
}
