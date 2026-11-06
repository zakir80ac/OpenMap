// T-313 REQ-DISC-025 — certificate chains recorded by the collector's Probe from real TLS servers
// (NGINX with an RSA chain, HAProxy with an ECDSA chain, both issued by an OpenSSL lab PKI) are fed
// through facts/Emit, and the CIs, key facts, issuer edges and the secured listener are checked.
package certificate

import (
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

const fixtureFamily = "../../../../packages/testing/fixtures/vendor/certificate"

type handshakeRecord struct {
	ServerName  string `json:"serverName"`
	TLSVersion  string `json:"tlsVersion"`
	CipherSuite string `json:"cipherSuite"`
	ChainLength int    `json:"chainLength"`
	Verified    bool   `json:"verifiedAgainstSystemRoots"`
	VerifyError string `json:"verifyError"`
}

type certExpect struct {
	port                       int
	leafCN, issuerCN           string
	leafKey, issuerKey         string
	leafBits, issuerBits       int
	leafSignature              string
	dnsNames                   []string
	validityDays               int
	tlsVersion, cipherContains string
}

var certFixtures = map[string]certExpect{
	"nginx-nginx-1.29.5": {port: 443, leafCN: "nginx.fxlab.test", issuerCN: "OpenMap Lab Issuing CA RSA", leafKey: "RSA", issuerKey: "RSA", leafBits: 2048, issuerBits: 2048,
		leafSignature: "SHA256-RSA", dnsNames: []string{"nginx.fxlab.test", "www.fxlab.test"}, validityDays: 397, tlsVersion: "TLS 1.3", cipherContains: "TLS_AES_"},
	"haproxy-haproxy-3.2.26": {port: 8443, leafCN: "haproxy.fxlab.test", issuerCN: "OpenMap Lab Issuing CA ECDSA", leafKey: "ECDSA", issuerKey: "ECDSA", leafBits: 256, issuerBits: 384,
		leafSignature: "ECDSA-SHA256", dnsNames: []string{"haproxy.fxlab.test"}, validityDays: 30, tlsVersion: "TLS 1.3", cipherContains: "TLS_AES_"},
}

func readPEM(t *testing.T, path string) []*x509.Certificate {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var out []*x509.Certificate
	for {
		var block *pem.Block
		block, raw = pem.Decode(raw)
		if block == nil {
			return out
		}
		c, err := x509.ParseCertificate(block.Bytes)
		if err != nil {
			t.Fatal(err)
		}
		out = append(out, c)
	}
}

func TestREQDISC025_T313_RecordedVendorFixtures(t *testing.T) {
	entries, err := os.ReadDir(fixtureFamily)
	if err != nil {
		t.Fatal(err)
	}
	seen := 0
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		seen++
		want, ok := certFixtures[entry.Name()]
		if !ok {
			t.Fatalf("fixture %s has no expectation row", entry.Name())
		}
		dir := filepath.Join(fixtureFamily, entry.Name())
		t.Run(entry.Name(), func(t *testing.T) {
			var hs handshakeRecord
			raw, err := os.ReadFile(filepath.Join(dir, "handshake.json"))
			if err != nil {
				t.Fatal(err)
			}
			if err := json.Unmarshal(raw, &hs); err != nil {
				t.Fatal(err)
			}
			chain := readPEM(t, filepath.Join(dir, "chain.pem"))
			if len(chain) != hs.ChainLength || len(chain) != 2 {
				t.Fatalf("chain length %d, handshake recorded %d", len(chain), hs.ChainLength)
			}
			if hs.Verified || hs.VerifyError == "" {
				t.Fatalf("lab chain must not verify against system roots: %+v", hs)
			}
			// The recording is a real chain: it verifies against the lab root with the presented intermediate.
			roots := x509.NewCertPool()
			for _, c := range readPEM(t, filepath.Join(dir, "lab-root-ca.crt")) {
				roots.AddCert(c)
			}
			inter := x509.NewCertPool()
			inter.AddCert(chain[1])
			if _, err := chain[0].Verify(x509.VerifyOptions{DNSName: hs.ServerName, Roots: roots, Intermediates: inter, CurrentTime: chain[0].NotBefore.Add(time.Hour)}); err != nil {
				t.Fatalf("recorded chain does not verify to the lab root: %v", err)
			}

			ep := Endpoint{Host: "127.0.0.1", Port: want.port, ServerName: hs.ServerName, Version: hs.TLSVersion, Cipher: hs.CipherSuite, Chain: chain, Verified: hs.Verified, VerifyErr: hs.VerifyError}
			obs := Emit([]Endpoint{ep}, contract.Target{Kind: "host", Value: hs.ServerName}, time.Now())

			certs := map[string]contract.ObservedCi{}
			listeners := 0
			for _, ci := range obs.Cis {
				switch ci.Type {
				case typeCertificate:
					certs[ci.Name] = ci
				case typeListener:
					listeners++
					if ci.Identity["port"] != strconv.Itoa(want.port) || ci.Attributes["tlsVersion"] != want.tlsVersion || ci.Attributes["chainVerified"] != false || ci.Attributes["serverName"] != hs.ServerName {
						t.Fatalf("listener %+v %+v", ci.Identity, ci.Attributes)
					}
					if cs, _ := ci.Attributes["cipherSuite"].(string); len(cs) < len(want.cipherContains) || cs[:len(want.cipherContains)] != want.cipherContains {
						t.Fatalf("cipher %v", ci.Attributes["cipherSuite"])
					}
				}
			}
			if len(certs) != 2 || listeners != 1 || len(obs.Evidence) != 2 {
				t.Fatalf("observation shape: %d certs, %d listeners, %d evidence", len(certs), listeners, len(obs.Evidence))
			}
			leaf, issuer := certs[want.leafCN], certs[want.issuerCN]
			sum := sha256.Sum256(chain[0].Raw)
			if leaf.Identity["fingerprintSha256"] != hex.EncodeToString(sum[:]) {
				t.Fatalf("leaf fingerprint %v", leaf.Identity)
			}
			la, ia := leaf.Attributes, issuer.Attributes
			if la["keyAlgorithm"] != want.leafKey || la["keyBits"] != want.leafBits || la["signatureAlgorithm"] != want.leafSignature || la["isCa"] != false || la["selfSigned"] != false || la["chainDepth"] != 0 {
				t.Fatalf("leaf facts %+v", la)
			}
			if ia["keyAlgorithm"] != want.issuerKey || ia["keyBits"] != want.issuerBits || ia["isCa"] != true || ia["chainDepth"] != 1 || ia["subject"] != la["issuer"] {
				t.Fatalf("issuer facts %+v", ia)
			}
			names, _ := la["dnsNames"].([]string)
			ips, _ := la["ipAddresses"].([]string)
			if len(names) != len(want.dnsNames) || names[0] != want.dnsNames[0] || len(ips) != 1 || ips[0] != "127.0.0.1" {
				t.Fatalf("leaf SANs %v %v", names, ips)
			}
			nb, _ := time.Parse(time.RFC3339, la["notBefore"].(string))
			na, _ := time.Parse(time.RFC3339, la["notAfter"].(string))
			if days := int(na.Sub(nb).Hours() / hoursPerDay); days != want.validityDays {
				t.Fatalf("leaf validity %d days, issued for %d", days, want.validityDays)
			}
			rels := map[string]int{}
			for _, r := range obs.Relationships {
				rels[r.Type]++
				if r.Type == relDependsOn && (r.From.Identity["fingerprintSha256"] != leaf.Identity["fingerprintSha256"] || r.To.Identity["fingerprintSha256"] != issuer.Identity["fingerprintSha256"]) {
					t.Fatalf("issuer edge %+v", r)
				}
				if r.Type == relSecuredBy && r.To.Identity["fingerprintSha256"] != leaf.Identity["fingerprintSha256"] {
					t.Fatalf("secured_by edge %+v", r)
				}
			}
			if rels[relDependsOn] != 1 || rels[relSecuredBy] != 1 {
				t.Fatalf("relationship mix %+v", rels)
			}
		})
	}
	if seen != len(certFixtures) {
		t.Fatalf("found %d certificate fixtures, expected %d", seen, len(certFixtures))
	}
}
