// T-416 REQ-DISC-020 — regression: web services on ports no table names. Simulated mode (ADR-042) serves
// every banner on an ephemeral port and showed that HTTP and HTTPS there came out as "unknown": Probe sent
// HEAD only on listed web ports, so a quiet web server on an unlisted port (HTTPS management on 4343, a
// console on 9443) never produced a Server header. Probe now asks a silent unlisted port with HEAD, inside
// TLS when the handshake succeeds; a silent non-web service on an unlisted port stays unknown.
package portscan

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestREQDISC020_T416_UnlistedPortWebServices(t *testing.T) {
	web := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Server", "lighttpd/1.4.76")
		w.WriteHeader(http.StatusOK)
	}))
	defer web.Close()
	secure := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Server", "Microsoft-IIS/10.0")
		w.WriteHeader(http.StatusOK)
	}))
	defer secure.Close()
	silent, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer silent.Close()
	go func() {
		for {
			c, err := silent.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				_ = c.SetReadDeadline(time.Now().Add(2 * time.Second))
				buf := make([]byte, bannerBytes)
				for {
					if _, err := c.Read(buf); err != nil {
						return
					}
				}
			}(c)
		}
	}()
	timeout := 500 * time.Millisecond
	cases := []struct {
		port             int
		service, product string
		tls              bool
	}{
		{portOf(t, web), "http", "lighttpd/1.4.76", false},
		{portOf(t, secure), "https", "Microsoft-IIS/10.0", true},
		{silent.Addr().(*net.TCPAddr).Port, "unknown", "", false},
	}
	for _, c := range cases {
		if portServices[c.port] != "" || httpPorts[c.port] || tlsFirstPorts[c.port] {
			t.Skipf("ephemeral port %d collides with a listed port", c.port)
		}
		p := Probe(context.Background(), "127.0.0.1", c.port, time.Second, timeout)
		if p == nil {
			t.Fatalf("port %d reported closed", c.port)
		}
		if p.Service != c.service || p.Product != c.product || p.TLS != c.tls {
			t.Errorf("port %d: got service=%q product=%q tls=%v, want %q %q %v (banner %q)", c.port, p.Service, p.Product, p.TLS, c.service, c.product, c.tls, p.Banner)
		}
	}
}
