// T-042 REQ-DISC-020 — scans loopback listeners started by the test (an SSH-style banner, an HTTP
// server and a TLS server) and checks service classification and the emitted unknown/host, IP and
// listening-service CIs.
package portscan

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"testing"
	"time"
)

func listenBanner(t *testing.T, banner string) int {
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
			_, _ = c.Write([]byte(banner))
			_ = c.Close()
		}
	}()
	return ln.Addr().(*net.TCPAddr).Port
}

func portOf(t *testing.T, srv *httptest.Server) int {
	t.Helper()
	u, _ := url.Parse(srv.URL)
	p, _ := strconv.Atoi(u.Port())
	return p
}

func TestScanAndEmit(t *testing.T) {
	sshPort := listenBanner(t, "SSH-2.0-OpenSSH_9.6p1 Ubuntu-3ubuntu13\r\n")
	web := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Server", "nginx/1.27.1")
		w.WriteHeader(http.StatusOK)
	}))
	defer web.Close()
	tlsSrv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) }))
	defer tlsSrv.Close()
	closed := listenBanner(t, "")
	closedPort := closed
	ports := []int{sshPort, portOf(t, web), portOf(t, tlsSrv), closedPort}
	// httpPorts/tlsFirstPorts are keyed by well-known numbers; ephemeral ports exercise the banner and silent-TLS paths.
	open := Scan(context.Background(), "127.0.0.1", ports, 8, time.Second, 500*time.Millisecond)
	if len(open) != 4 {
		t.Fatalf("expected 4 open ports, got %d: %+v", len(open), open)
	}
	byPort := map[int]Port{}
	for _, p := range open {
		byPort[p.Port] = p
	}
	if s := byPort[sshPort]; s.Service != "ssh" || s.Product != "OpenSSH" || s.Version != "9.6p1" {
		t.Fatalf("ssh classification wrong: %+v", s)
	}
	if h := byPort[portOf(t, tlsSrv)]; !h.TLS {
		t.Fatalf("tls server not detected: %+v", h)
	}
	obs := Emit("127.0.0.1", "", open, time.Now())
	if obs.Cis[0].Type != typeUnknown || obs.Cis[0].Identity["address"] != "127.0.0.1" || obs.Cis[1].Type != typeIP {
		t.Fatalf("host/ip emission wrong: %+v", obs.Cis[:2])
	}
	if n := len(obs.Cis) - 2; n != 4 {
		t.Fatalf("expected 4 listeners, got %d", n)
	}
	named := Emit("127.0.0.1", "lab-host.corp.example", open, time.Now())
	if named.Cis[0].Type != typeHost || named.Cis[0].Identity["fqdn"] != "lab-host.corp.example" {
		t.Fatalf("rdns host emission wrong: %+v", named.Cis[0])
	}
}

func TestClassifyHttpBanner(t *testing.T) {
	p := Port{Port: 8080, Banner: "HTTP/1.0 200 OK\r\nServer: Apache/2.4.62 (Unix)\r\n"}
	Classify(&p)
	if p.Service != "http" || p.Product != "Apache/2.4.62 (Unix)" {
		t.Fatalf("http classification wrong: %+v", p)
	}
	q := Port{Port: 3389}
	Classify(&q)
	if q.Service != "rdp" {
		t.Fatalf("port fallback wrong: %+v", q)
	}
	if guessClass([]Port{q, {Service: "winrm"}}) != "windows-host" {
		t.Fatal("class guess wrong")
	}
}

func TestCollectNothingOpen(t *testing.T) {
	_, err := Collector{}.Collect(context.Background(), contractTarget("127.0.0.1"), nil, map[string]any{"ports": []any{float64(1)}, "connectTimeoutMs": float64(300)})
	if err == nil {
		t.Fatal("expected unreachable")
	}
}
