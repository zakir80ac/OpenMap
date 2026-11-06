// T-318 REQ-DISC-011 — Docker Engine collector helpers: endpoint parsing, API version negotiation,
// label filters, registry provenance, attribute rendering and the unix-socket transport.
package docker

import (
	"context"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

func TestParseEndpoint(t *testing.T) {
	cases := []struct {
		in     string
		tls    bool
		scheme string
		host   string
		socket string
	}{
		{"unix:///var/run/docker.sock", false, schemeUnix, "", "/var/run/docker.sock"},
		{"tcp://10.0.0.5", false, schemeHTTP, "10.0.0.5:2375", ""},
		{"tcp://10.0.0.5", true, schemeHTTPS, "10.0.0.5:2376", ""},
		{"tcp://engine.lab:2380", false, schemeHTTP, "engine.lab:2380", ""},
		{"https://engine.lab", false, schemeHTTPS, "engine.lab:2376", ""},
		{"engine.lab", false, schemeHTTP, "engine.lab:2375", ""},
	}
	for _, c := range cases {
		ep, err := ParseEndpoint(c.in, c.tls)
		if err != nil || ep.Scheme != c.scheme || ep.Host != c.host || ep.Socket != c.socket {
			t.Errorf("%s: %+v %v", c.in, ep, err)
		}
	}
	for _, bad := range []string{"unix://", "ftp://x", "tcp://"} {
		if _, err := ParseEndpoint(bad, false); err == nil {
			t.Errorf("%s accepted", bad)
		}
	}
}

func TestNegotiateAPIVersion(t *testing.T) {
	cases := map[[2]string]string{
		{"1.55", "1.40"}: clientMaxAPIVersion,
		{"1.43", "1.12"}: "1.43",
		{"1.60", "1.50"}: "1.50",
		{"", ""}:         clientMaxAPIVersion,
	}
	for in, want := range cases {
		if got := NegotiateAPIVersion(in[0], in[1]); got != want {
			t.Errorf("%v: %s want %s", in, got, want)
		}
	}
}

func TestLabelFilters(t *testing.T) {
	if LabelFilters(map[string]any{}) != "" {
		t.Error("no filter expected")
	}
	if got := LabelFilters(map[string]any{optionLabelFilter: []any{"a=b", "c"}}); got != `{"label":["a=b","c"]}` {
		t.Errorf("filters %s", got)
	}
}

func TestImageRegistries(t *testing.T) {
	pulled := ImageDoc{RepoDigests: []string{"postgres@sha256:1", "ghcr.io/x/y@sha256:2"}}
	if hosts, src := ImageRegistries(pulled, false); src != imageFromRegistry || !equal(hosts, []string{"ghcr.io", defaultRegistry}) {
		t.Errorf("classic store: %v %s", hosts, src)
	}
	if hosts, src := ImageRegistries(pulled, true); src != imageAssumed || len(hosts) != 2 {
		t.Errorf("containerd store: %v %s", hosts, src)
	}
	if _, src := ImageRegistries(ImageDoc{}, false); src != imageLocal {
		t.Errorf("no digest: %s", src)
	}
	compose := ImageDoc{RepoDigests: []string{"team/app@sha256:3"}, Labels: map[string]string{labelComposeProject: "team"}}
	if hosts, src := ImageRegistries(compose, true); src != imageLocal || len(hosts) != 0 {
		t.Errorf("compose build: %v %s", hosts, src)
	}
	if RegistryOf("localhost:5000/app") != "localhost:5000" || RegistryOf("library/redis") != defaultRegistry {
		t.Error("RegistryOf")
	}
}

func TestAttributeRendering(t *testing.T) {
	ports := PortStrings([]PortDoc{{IP: "0.0.0.0", PrivatePort: 80, PublicPort: 8080, Type: "tcp"}, {IP: "::", PrivatePort: 80, PublicPort: 8080, Type: "tcp"}, {PrivatePort: 6379, Type: "tcp"}})
	if !equal(ports, []string{"0.0.0.0:8080->80/tcp", "6379/tcp", "[::]:8080->80/tcp"}) {
		t.Errorf("ports %v", ports)
	}
	labels := LabelStrings(map[string]string{"app": "shop", "DB_PASSWORD": "x", "vault.token": "y", "com.example.api_key": "z"})
	if !equal(labels, []string{"app=shop"}) {
		t.Errorf("labels %v", labels)
	}
	mounts := MountStrings([]MountDoc{{Type: "volume", Name: "data", Source: "/var/lib/docker/volumes/data/_data", Destination: "/data", RW: true}, {Type: "bind", Source: "/etc/app", Destination: "/cfg"}})
	if !equal(mounts, []string{"bind:/etc/app->/cfg:ro", "volume:data->/data:rw"}) {
		t.Errorf("mounts %v", mounts)
	}
}

// The unix transport dials the socket and speaks HTTP over it (AF_UNIX works on Linux, macOS and Windows 10+).
func TestUnixSocketTransport(t *testing.T) {
	sock := filepath.Join(t.TempDir(), "engine.sock")
	l, err := net.Listen(schemeUnix, sock)
	if err != nil {
		t.Skipf("unix sockets unavailable: %v", err)
	}
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == pathPing {
			w.Header().Set(headerAPIVersion, "1.44")
			_, _ = w.Write([]byte("OK"))
			return
		}
		w.WriteHeader(http.StatusInternalServerError)
	})}
	go func() { _ = srv.Serve(l) }()
	t.Cleanup(func() { _ = srv.Close(); _ = os.Remove(sock) })
	c := NewClient(Endpoint{Scheme: schemeUnix, Socket: sock}, nil)
	h, err := c.get(context.Background(), pathPing, nil, nil)
	if err != nil || h.Get(headerAPIVersion) != "1.44" {
		t.Fatalf("ping over unix socket: %v %v", h, err)
	}
	_, err = c.get(context.Background(), pathInfo, nil, &InfoDoc{})
	if err == nil {
		t.Fatal("500 must be an error")
	}
}

func TestCollectWithBadClientCertificate(t *testing.T) {
	cred := &contract.Credential{Type: credTypeCertificate, Fields: map[string]string{credFieldCert: "x", credFieldKey: "y"}}
	if _, err := (Collector{}).Collect(context.Background(), contract.Target{Kind: "url", Value: "tcp://127.0.0.1:1"}, cred, map[string]any{}); err == nil {
		t.Fatal("an unusable client certificate must fail")
	}
}
