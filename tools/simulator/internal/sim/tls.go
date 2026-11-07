// REQ-QA-005 — a throwaway CA per simulator process and a loopback server certificate, so collectors run with
// TLS verification on (caCertPem) exactly as they do against a private-CA appliance.
package sim

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
	"time"
)

const (
	certLifetime = 24 * time.Hour
	serialBits   = 62
	caName       = "OpenMap simulated-mode CA"
	leafName     = "openmap-simulator"
)

type CA struct {
	// PEM is the CA certificate collectors pin (option caCertPem).
	PEM  string
	Leaf tls.Certificate
	// LeafPEM and KeyPEM are the server certificate and key, for simulators that need them as files.
	LeafPEM string
	KeyPEM  string
}

func serial() (*big.Int, error) {
	return rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), serialBits))
}

func NewCA() (*CA, error) {
	caKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	now := time.Now()
	sn, err := serial()
	if err != nil {
		return nil, err
	}
	caTpl := &x509.Certificate{
		SerialNumber: sn, Subject: pkix.Name{CommonName: caName, Organization: []string{Provenance}},
		NotBefore: now.Add(-time.Hour), NotAfter: now.Add(certLifetime),
		IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature,
	}
	caDer, err := x509.CreateCertificate(rand.Reader, caTpl, caTpl, &caKey.PublicKey, caKey)
	if err != nil {
		return nil, err
	}
	caCert, err := x509.ParseCertificate(caDer)
	if err != nil {
		return nil, err
	}
	leafKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	sn2, err := serial()
	if err != nil {
		return nil, err
	}
	leafTpl := &x509.Certificate{
		SerialNumber: sn2, Subject: pkix.Name{CommonName: leafName, Organization: []string{Provenance}},
		NotBefore: now.Add(-time.Hour), NotAfter: now.Add(certLifetime),
		DNSNames: dnsNames(), IPAddresses: ipAddresses(),
		KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	leafDer, err := x509.CreateCertificate(rand.Reader, leafTpl, caCert, &leafKey.PublicKey, caKey)
	if err != nil {
		return nil, err
	}
	keyDer, err := x509.MarshalECPrivateKey(leafKey)
	if err != nil {
		return nil, err
	}
	leafPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: leafDer})
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDer})
	pair, err := tls.X509KeyPair(leafPEM, keyPEM)
	if err != nil {
		return nil, err
	}
	return &CA{
		PEM:  string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: caDer})),
		Leaf: pair, LeafPEM: string(leafPEM), KeyPEM: string(keyPEM),
	}, nil
}

func (ca *CA) ServerConfig() *tls.Config {
	return &tls.Config{Certificates: []tls.Certificate{ca.Leaf}, MinVersion: tls.VersionTLS12}
}

func dnsNames() []string {
	names := []string{"localhost"}
	if net.ParseIP(advertiseHost) == nil && advertiseHost != "localhost" {
		names = append(names, advertiseHost)
	}
	return names
}

func ipAddresses() []net.IP {
	ips := []net.IP{net.IPv4(127, 0, 0, 1), net.IPv6loopback}
	if ip := net.ParseIP(advertiseHost); ip != nil && !ip.IsLoopback() {
		ips = append(ips, ip)
	}
	return ips
}
