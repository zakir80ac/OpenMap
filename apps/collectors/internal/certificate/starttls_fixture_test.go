// T-316 REQ-DISC-025 — StartTLS recordings from real servers (Postfix SMTP on 25 and 587, Dovecot IMAP
// and POP3, OpenLDAP StartTLS extended operation, PostgreSQL SSLRequest), each captured by the
// collector's ProbeStartTLS through a recording proxy against the container lab
// (packages/testing/fixtures/vendor/certificate/*-starttls). Two halves per fixture:
//  1. negotiation: a local listener replays the recorded server dialogue byte for byte, requires the
//     collector to send exactly the recorded client bytes, then upgrades to TLS. The lab private keys
//     are not checked in, so this listener presents a throwaway certificate generated here.
//  2. chain: the recorded chain verifies to the lab root and runs through facts/Emit, which must
//     report the StartTLS protocol on the secured listener.
package certificate

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/json"
	"io"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

const (
	startTLSFixtureSuffix = "-starttls"
	replayCN              = "starttls-replay.invalid"
)

type startTLSHandshake struct {
	handshakeRecord
	StartTLS string `json:"startTls"`
	Port     int    `json:"port"`
}

type dialogue struct {
	Protocol string `json:"protocol"`
	Steps    []struct {
		From  string `json:"from"`
		Bytes int    `json:"bytes"`
	} `json:"steps"`
}

type startTLSExpect struct {
	protocol      string
	port          int
	wellKnownPort int // the port "auto" resolves to this protocol from
	cert          certExpect
	cipher        string
}

var mailCert = certExpect{leafCN: "mail.fxlab.test", issuerCN: "OpenMap Lab Issuing CA RSA", leafKey: "RSA", issuerKey: "RSA", leafBits: 2048, issuerBits: 2048,
	leafSignature: "SHA256-RSA", dnsNames: []string{"mail.fxlab.test", "smtp.fxlab.test", "imap.fxlab.test"}, validityDays: 365, tlsVersion: "TLS 1.3"}

var startTLSFixtures = map[string]startTLSExpect{
	"postfix-postfix-3.9.11-starttls":            {protocol: StartTLSSMTP, port: 25, wellKnownPort: 25, cert: mailCert, cipher: "TLS_AES_128_GCM_SHA256"},
	"postfix-postfix-3.9.11-submission-starttls": {protocol: StartTLSSMTP, port: 587, wellKnownPort: 587, cert: mailCert, cipher: "TLS_AES_128_GCM_SHA256"},
	"dovecot-dovecot-2.3.21.1-imap-starttls":     {protocol: StartTLSIMAP, port: 143, wellKnownPort: 143, cert: mailCert, cipher: "TLS_AES_128_GCM_SHA256"},
	"dovecot-dovecot-2.3.21.1-pop3-starttls":     {protocol: StartTLSPOP3, port: 110, wellKnownPort: 110, cert: mailCert, cipher: "TLS_AES_128_GCM_SHA256"},
	"openldap-slapd-2.6.10-starttls": {protocol: StartTLSLDAP, port: 1389, wellKnownPort: 389, cipher: "TLS_AES_256_GCM_SHA384",
		cert: certExpect{leafCN: "ldap.fxlab.test", issuerCN: "OpenMap Lab Issuing CA ECDSA", leafKey: "ECDSA", issuerKey: "ECDSA", leafBits: 256, issuerBits: 384,
			leafSignature: "ECDSA-SHA256", dnsNames: []string{"ldap.fxlab.test"}, validityDays: 90, tlsVersion: "TLS 1.3"}},
	"postgresql-postgresql-17.11-starttls": {protocol: StartTLSPostgres, port: 5432, wellKnownPort: 5432, cipher: "TLS_AES_256_GCM_SHA384",
		cert: certExpect{leafCN: "pg.fxlab.test", issuerCN: "OpenMap Lab Issuing CA RSA", leafKey: "RSA", issuerKey: "RSA", leafBits: 3072, issuerBits: 2048,
			leafSignature: "SHA384-RSA", dnsNames: []string{"pg.fxlab.test"}, validityDays: 180, tlsVersion: "TLS 1.3"}},
}

func replayCertificate(t *testing.T) tls.Certificate {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tpl := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: replayCN}, DNSNames: []string{replayCN},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	der, err := x509.CreateCertificate(rand.Reader, tpl, tpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}
}

// replayServer plays the recorded server side, checks the client side byte for byte, then hands the
// connection to TLS. The returned channel yields the first divergence (nil when the dialogue matched).
func replayServer(t *testing.T, d dialogue, server, client []byte, cert tls.Certificate) (int, <-chan error) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	result := make(chan error, 1)
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			result <- err
			return
		}
		defer conn.Close()
		_ = conn.SetDeadline(time.Now().Add(dialTimeout))
		so, co := 0, 0
		for _, st := range d.Steps {
			switch st.From {
			case "server":
				if _, err := conn.Write(server[so : so+st.Bytes]); err != nil {
					result <- err
					return
				}
				so += st.Bytes
			case "client":
				got := make([]byte, st.Bytes)
				if _, err := io.ReadFull(conn, got); err != nil {
					result <- err
					return
				}
				if want := client[co : co+st.Bytes]; !bytes.Equal(got, want) {
					result <- &dialogueError{got: got, want: want}
					return
				}
				co += st.Bytes
			}
		}
		if so != len(server) || co != len(client) {
			result <- &dialogueError{got: []byte(strconv.Itoa(so) + "/" + strconv.Itoa(co)), want: []byte(strconv.Itoa(len(server)) + "/" + strconv.Itoa(len(client)))}
			return
		}
		tc := tls.Server(conn, &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12})
		result <- tc.Handshake()
	}()
	return ln.Addr().(*net.TCPAddr).Port, result
}

type dialogueError struct{ got, want []byte }

func (e *dialogueError) Error() string {
	return "client sent " + strconv.Quote(string(e.got)) + ", recorded " + strconv.Quote(string(e.want))
}

func readFixtureJSON(t *testing.T, path string, v any) {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, v); err != nil {
		t.Fatalf("%s: %v", path, err)
	}
}

func TestREQDISC025_T316_RecordedStartTLSFixtures(t *testing.T) {
	entries, err := os.ReadDir(fixtureFamily)
	if err != nil {
		t.Fatal(err)
	}
	replay := replayCertificate(t)
	seen := 0
	for _, entry := range entries {
		if !entry.IsDir() || !strings.HasSuffix(entry.Name(), startTLSFixtureSuffix) {
			continue
		}
		seen++
		want, ok := startTLSFixtures[entry.Name()]
		if !ok {
			t.Fatalf("fixture %s has no expectation row", entry.Name())
		}
		dir := filepath.Join(fixtureFamily, entry.Name())
		t.Run(entry.Name(), func(t *testing.T) {
			var manifest struct {
				Family string `json:"family"`
				Req    string `json:"req"`
			}
			readFixtureJSON(t, filepath.Join(dir, "manifest.json"), &manifest)
			if manifest.Family != "certificate" || manifest.Req != "REQ-DISC-025" {
				t.Fatalf("manifest %+v", manifest)
			}
			var hs startTLSHandshake
			readFixtureJSON(t, filepath.Join(dir, "handshake.json"), &hs)
			var d dialogue
			readFixtureJSON(t, filepath.Join(dir, "dialogue.json"), &d)
			if hs.StartTLS != want.protocol || d.Protocol != want.protocol || hs.Port != want.port || hs.CipherSuite != want.cipher || hs.TLSVersion != want.cert.tlsVersion {
				t.Fatalf("recorded handshake %+v / dialogue %s", hs, d.Protocol)
			}
			if got, err := StartTLSProtocol(startTLSAuto, want.wellKnownPort); err != nil || got != want.protocol {
				t.Fatalf("auto on port %d resolves to %q (%v)", want.wellKnownPort, got, err)
			}
			server, err := os.ReadFile(filepath.Join(dir, "dialogue.server.bin"))
			if err != nil {
				t.Fatal(err)
			}
			client, err := os.ReadFile(filepath.Join(dir, "dialogue.client.bin"))
			if err != nil {
				t.Fatal(err)
			}

			// 1. The real StartTLS client against the recorded server dialogue.
			port, result := replayServer(t, d, server, client, replay)
			ctx, cancel := context.WithTimeout(context.Background(), dialTimeout)
			defer cancel()
			ep := ProbeStartTLS(ctx, "127.0.0.1", port, hs.ServerName, hs.StartTLS)
			if err := <-result; err != nil {
				t.Fatalf("replayed %s dialogue: %v", want.protocol, err)
			}
			if ep.Error != "" || ep.StartTLS != want.protocol || len(ep.Chain) != 1 || ep.Chain[0].Subject.CommonName != replayCN || ep.Version == "" {
				t.Fatalf("probe over the replayed dialogue: %+v", ep)
			}

			// 2. The chain the real server presented after the upgrade.
			chain := readPEM(t, filepath.Join(dir, "chain.pem"))
			if len(chain) != hs.ChainLength || len(chain) != 2 || hs.Verified || hs.VerifyError == "" {
				t.Fatalf("chain %d certs, handshake %+v", len(chain), hs)
			}
			roots := x509.NewCertPool()
			for _, c := range readPEM(t, filepath.Join(dir, "lab-root-ca.crt")) {
				roots.AddCert(c)
			}
			inter := x509.NewCertPool()
			inter.AddCert(chain[1])
			if _, err := chain[0].Verify(x509.VerifyOptions{DNSName: hs.ServerName, Roots: roots, Intermediates: inter, CurrentTime: chain[0].NotBefore.Add(time.Hour)}); err != nil {
				t.Fatalf("recorded chain does not verify to the lab root: %v", err)
			}
			recorded := Endpoint{Host: "127.0.0.1", Port: hs.Port, ServerName: hs.ServerName, StartTLS: hs.StartTLS, Version: hs.TLSVersion, Cipher: hs.CipherSuite, Chain: chain, Verified: hs.Verified, VerifyErr: hs.VerifyError}
			obs := Emit([]Endpoint{recorded}, contract.Target{Kind: "host", Value: hs.ServerName}, time.Now())
			certs := map[string]contract.ObservedCi{}
			listeners := 0
			for _, ci := range obs.Cis {
				switch ci.Type {
				case typeCertificate:
					certs[ci.Name] = ci
				case typeListener:
					listeners++
					wantName := "tcp/" + strconv.Itoa(want.port) + " " + want.protocol + " starttls"
					if ci.Name != wantName || ci.Identity["port"] != strconv.Itoa(want.port) || ci.Attributes["startTls"] != want.protocol || ci.Attributes["tls"] != true ||
						ci.Attributes["tlsVersion"] != want.cert.tlsVersion || ci.Attributes["cipherSuite"] != want.cipher || ci.Attributes["chainVerified"] != false {
						t.Fatalf("listener %q %+v %+v", ci.Name, ci.Identity, ci.Attributes)
					}
				}
			}
			if len(certs) != 2 || listeners != 1 {
				t.Fatalf("observation shape: %d certs, %d listeners", len(certs), listeners)
			}
			leaf, issuer := certs[want.cert.leafCN], certs[want.cert.issuerCN]
			sum := sha256.Sum256(chain[0].Raw)
			if leaf.Identity["fingerprintSha256"] != hex.EncodeToString(sum[:]) {
				t.Fatalf("leaf fingerprint %v", leaf.Identity)
			}
			la, ia := leaf.Attributes, issuer.Attributes
			if la["keyAlgorithm"] != want.cert.leafKey || la["keyBits"] != want.cert.leafBits || la["signatureAlgorithm"] != want.cert.leafSignature || la["isCa"] != false || la["chainDepth"] != 0 {
				t.Fatalf("leaf facts %+v", la)
			}
			if ia["keyAlgorithm"] != want.cert.issuerKey || ia["keyBits"] != want.cert.issuerBits || ia["isCa"] != true || ia["chainDepth"] != 1 || ia["subject"] != la["issuer"] {
				t.Fatalf("issuer facts %+v", ia)
			}
			names, _ := la["dnsNames"].([]string)
			ips, _ := la["ipAddresses"].([]string)
			if strings.Join(names, ",") != strings.Join(want.cert.dnsNames, ",") || len(ips) != 1 || ips[0] != "127.0.0.1" {
				t.Fatalf("leaf SANs %v %v", names, ips)
			}
			nb, _ := time.Parse(time.RFC3339, la["notBefore"].(string))
			na, _ := time.Parse(time.RFC3339, la["notAfter"].(string))
			if days := int(na.Sub(nb).Hours() / hoursPerDay); days != want.cert.validityDays {
				t.Fatalf("leaf validity %d days, issued for %d", days, want.cert.validityDays)
			}
			rels := map[string]int{}
			for _, r := range obs.Relationships {
				rels[r.Type]++
			}
			if rels[relDependsOn] != 1 || rels[relSecuredBy] != 1 {
				t.Fatalf("relationship mix %+v", rels)
			}
		})
	}
	if seen != len(startTLSFixtures) {
		t.Fatalf("found %d StartTLS fixtures, expected %d", seen, len(startTLSFixtures))
	}

	// The option resolves explicitly, by port, or not at all; anything else is a job error, not direct TLS.
	for _, c := range []struct {
		option any
		port   int
		want   string
		fails  bool
	}{
		{nil, 443, "", false}, {false, 25, "", false}, {"", 25, "", false}, {true, 143, StartTLSIMAP, false}, {"SMTP", 2525, StartTLSSMTP, false},
		{startTLSAuto, 443, "", true}, {"xmpp", 5222, "", true}, {float64(1), 25, "", true},
	} {
		got, err := StartTLSProtocol(c.option, c.port)
		if got != c.want || (err != nil) != c.fails {
			t.Errorf("StartTLSProtocol(%v, %d) = %q, %v", c.option, c.port, got, err)
		}
	}
}
