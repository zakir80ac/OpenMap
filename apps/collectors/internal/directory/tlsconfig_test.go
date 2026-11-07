// T-415 REQ-DISC-023 — regression: LDAPS and StartTLS honour the caCertPem option. Simulated mode (ADR-042)
// showed that verifyTls=true checked domain controller certificates against the system roots only, so a
// controller with an enterprise-CA certificate could never be verified. A handshake against a server whose
// certificate an in-test CA issued must succeed with that CA as caCertPem and fail without it.
package directory

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"net"
	"testing"
	"time"
)

func testCA(t *testing.T) (string, tls.Certificate) {
	t.Helper()
	caKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	caTpl := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "Enterprise Root CA"}, NotBefore: now.Add(-time.Hour), NotAfter: now.Add(time.Hour),
		IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign}
	caDer, err := x509.CreateCertificate(rand.Reader, caTpl, caTpl, &caKey.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	caCert, _ := x509.ParseCertificate(caDer)
	leafKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	leafTpl := &x509.Certificate{SerialNumber: big.NewInt(2), Subject: pkix.Name{CommonName: "dc01.corp.example"}, NotBefore: now.Add(-time.Hour), NotAfter: now.Add(time.Hour),
		DNSNames: []string{"dc01.corp.example"}, KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	leafDer, err := x509.CreateCertificate(rand.Reader, leafTpl, caCert, &leafKey.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: caDer})), tls.Certificate{Certificate: [][]byte{leafDer}, PrivateKey: leafKey}
}

func handshake(t *testing.T, client *tls.Config, leaf tls.Certificate) error {
	t.Helper()
	a, b := net.Pipe()
	defer a.Close()
	defer b.Close()
	go func() {
		srv := tls.Server(b, &tls.Config{Certificates: []tls.Certificate{leaf}, MinVersion: tls.VersionTLS12})
		_ = srv.Handshake()
	}()
	c := tls.Client(a, client)
	_ = c.SetDeadline(time.Now().Add(5 * time.Second))
	return c.Handshake()
}

func TestREQDISC023_T415_TLSHonoursCACertPem(t *testing.T) {
	caPem, leaf := testCA(t)
	pinned, err := TLSConfig("dc01.corp.example", true, caPem)
	if err != nil {
		t.Fatal(err)
	}
	if err := handshake(t, pinned, leaf); err != nil {
		t.Fatalf("handshake with caCertPem failed: %v", err)
	}
	system, err := TLSConfig("dc01.corp.example", true, "")
	if err != nil {
		t.Fatal(err)
	}
	if err := handshake(t, system, leaf); err == nil {
		t.Fatal("an enterprise-CA certificate verified against the system roots")
	}
	if _, err := TLSConfig("dc01.corp.example", true, "not a certificate"); err == nil {
		t.Fatal("a caCertPem without a certificate was accepted")
	}
}
