// T-321 REQ-DISC-020 — recorded port-only and second-product fixtures: services whose identity rests on
// the port (RDP, SQL Server, Oracle, SMB, rpcbind, LDAP, DNS, MongoDB, AMQP, Docker, etcd, kubelet,
// kube-apiserver) and further banner products (Exim, ProFTPD, Pure-FTPd, OpenSearch), captured in the
// container lab with Probe's exact socket IO. Silent services are replayed through the real Probe
// (banner read, then the TLS retry); recorded TLS chains go through tlsName; HTTP replies through
// readBanner after Probe's HEAD request; then Classify and Emit.
package portscan

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"testing"
	"time"
)

type portOnlyRecord struct {
	captureRecord
	TLSError string `json:"tlsError"`
}

// portOnlyExpectations are the fixture dirs T-321 owns; T-308 skips them.
var portOnlyExpectations = map[string]hostExpect{
	// An xrdp Linux box is indistinguishable from Windows RDP without speaking RDP: the port decides.
	"neutrinolabs-xrdp-0.9.21.1": {address: "192.168.112.2", classification: "windows-host", ports: map[int]portExpect{3389: {service: "rdp"}}},
	"exim-exim-4.96":             {address: "192.168.112.3", classification: "unclassified", ports: map[int]portExpect{25: {service: "smtp", product: "Exim"}}},
	"proftpd-proftpd-1.3.8":      {address: "192.168.112.4", classification: "unclassified", ports: map[int]portExpect{21: {service: "ftp", product: "ProFTPD"}}},
	"pureftpd-pure-ftpd-1.0.50":  {address: "192.168.112.5", classification: "unclassified", ports: map[int]portExpect{21: {service: "ftp", product: "Pure-FTPd"}}},
	"samba-smbd-4.17.12": {address: "192.168.112.6", classification: "unclassified", ports: map[int]portExpect{
		111: {service: "rpcbind"}, 139: {service: "netbios"}, 445: {service: "smb"},
	}},
	"mongodb-mongodb-8.0.34": {address: "192.168.112.7", classification: "database-server", ports: map[int]portExpect{27017: {service: "mongodb"}}},
	"openldap-slapd-2.4.57": {address: "192.168.112.8", classification: "directory-server", ports: map[int]portExpect{
		389: {service: "ldap"}, 636: {service: "ldaps", tls: true, tlsName: "fxlab-k-ldap"},
	}},
	"isc-bind-9.20.30":                     {address: "192.168.112.9", classification: "unclassified", ports: map[int]portExpect{53: {service: "dns"}}},
	"docker-engine-28.5.2":                 {address: "192.168.112.10", classification: "unclassified", ports: map[int]portExpect{2375: {service: "docker"}}},
	"rabbitmq-rabbitmq-3.13.7":             {address: "192.168.112.11", classification: "unclassified", ports: map[int]portExpect{5672: {service: "amqp"}}},
	"opensearch-opensearch-2.19.1":         {address: "192.168.112.12", classification: "database-server", ports: map[int]portExpect{9200: {service: "elasticsearch"}}},
	"microsoft-sqlserver-2022-16.0.4305.5": {address: "192.168.112.13", classification: "database-server", ports: map[int]portExpect{1433: {service: "mssql"}}},
	"oracle-database-free-23.26.3":         {address: "192.168.112.2", classification: "database-server", ports: map[int]portExpect{1521: {service: "oracle"}}},
	"kubernetes-kind-node-v1.34.0": {address: "192.168.96.2", classification: "kubernetes-node", ports: map[int]portExpect{
		2379:  {service: "etcd", tls: true, tlsName: "openmap-control-plane"},
		6443:  {service: "kubernetes-api", tls: true, tlsName: "kube-apiserver"},
		10250: {service: "kubelet", tls: true, tlsName: "openmap-control-plane@1792676936"},
	}},
}

func recordedChain(t *testing.T, dir string, files []string) []*x509.Certificate {
	t.Helper()
	var chain []*x509.Certificate
	for _, f := range files {
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
	return chain
}

func replayPortOnly(t *testing.T, dir string, rec portOnlyRecord) Port {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(dir, rec.BannerFile))
	if err != nil {
		t.Fatal(err)
	}
	if len(raw) != rec.BannerBytes {
		t.Fatalf("%s: %d bytes on disk, capture recorded %d", rec.BannerFile, len(raw), rec.BannerBytes)
	}
	if rec.TLS != (len(rec.ChainFiles) > 0) {
		t.Fatalf("%s: tls=%v with %d chain files", rec.BannerFile, rec.TLS, len(rec.ChainFiles))
	}
	switch rec.Mode {
	case "banner":
		// The real Probe against a listener that sends the recorded bytes (or stays silent, which
		// also makes Probe's TLS retry fail as it did against every silent lab service but etcd).
		port := replayServer(t, raw, false, nil)
		p := Probe(context.Background(), "127.0.0.1", port, replayTimeout, replayTimeout)
		if p == nil {
			t.Fatalf("replay of %s: port reported closed", rec.BannerFile)
		}
		if p.TLS {
			t.Fatalf("replay of %s: TLS retry succeeded against a plain listener", rec.BannerFile)
		}
		p.Port, p.Service, p.Product, p.Version = rec.Port, "", "", ""
		if rec.TLS {
			// The recorded TLS retry succeeded; its chain stands in for the handshake the replay cannot redo.
			p.TLS = true
			p.TLSName = tlsName(tls.ConnectionState{PeerCertificates: recordedChain(t, dir, rec.ChainFiles)})
		}
		Classify(p)
		return *p
	case "tls-silent":
		// A TLS-first port outside the web list: Probe handshakes and reads nothing.
		if len(raw) != 0 {
			t.Fatalf("%s: tls-silent capture carries %d banner bytes", rec.BannerFile, len(raw))
		}
		p := Port{Port: rec.Port}
		if !tlsFirstPorts[rec.Port] || httpPorts[rec.Port] {
			t.Fatalf("port %d is not a TLS-first non-web port in Probe", rec.Port)
		}
		if rec.TLS {
			p.TLS = true
			p.TLSName = tlsName(tls.ConnectionState{PeerCertificates: recordedChain(t, dir, rec.ChainFiles)})
		}
		Classify(&p)
		return p
	case "http", "tls+http":
		return replayPort(t, dir, rec.captureRecord)
	default:
		t.Fatalf("unknown capture mode %q", rec.Mode)
		return Port{}
	}
}

func TestREQDISC020_T321_RecordedPortOnlyFixtures(t *testing.T) {
	if len(portOnlyExpectations) == 0 {
		t.Fatal("no port-only expectations")
	}
	entries, err := os.ReadDir(portFixtureRoot)
	if err != nil {
		t.Fatalf("fixture root: %v", err)
	}
	present := map[string]bool{}
	for _, e := range entries {
		present[e.Name()] = e.IsDir()
	}
	for name, exp := range portOnlyExpectations {
		if !present[name] {
			t.Errorf("expectation %s has no fixture dir", name)
			continue
		}
		t.Run(name, func(t *testing.T) {
			t.Parallel() // silent services cost two replay timeouts each
			dir := filepath.Join(portFixtureRoot, name)
			files, err := filepath.Glob(filepath.Join(dir, "*.json"))
			if err != nil || len(files) < 2 {
				t.Fatalf("no capture records in %s", dir)
			}
			var manifest struct {
				Family string `json:"family"`
				Req    string `json:"req"`
			}
			mb, err := os.ReadFile(filepath.Join(dir, "manifest.json"))
			if err != nil || json.Unmarshal(mb, &manifest) != nil || manifest.Family != "port_scan" || manifest.Req != "REQ-DISC-020" {
				t.Fatalf("manifest: %v %+v", err, manifest)
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
				var rec portOnlyRecord
				if err := json.Unmarshal(b, &rec); err != nil {
					t.Fatalf("%s: %v", f, err)
				}
				p := replayPortOnly(t, dir, rec)
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
			obs := Emit(exp.address, "", open, time.Date(2026, 11, 7, 0, 0, 0, 0, time.UTC))
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
				if got == nil || got["service"] != want.service || got["product"] != want.product || got["tls"] != want.tls || got["tlsName"] != want.tlsName {
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
			if net.ParseIP(exp.address) == nil {
				t.Fatalf("expectation address %q", exp.address)
			}
		})
	}
}
