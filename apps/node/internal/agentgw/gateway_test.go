// T-073 REQ-DISC-004 — the agent gateway over a real TLS listener: a CA, a node certificate and an agent certificate
// are generated in-process; enrolment passes without a client certificate, a report without one is refused, a
// report with the agent certificate is forwarded with the certificate's CN as agentId and its SHA-256 fingerprint,
// and a body claiming another agentId is rejected.
package agentgw

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"io"
	"log/slog"
	"math/big"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type fakeForwarder struct {
	enrols  []json.RawMessage
	reports []json.RawMessage
}

func (f *fakeForwarder) AgentEnrol(_ context.Context, body json.RawMessage) (json.RawMessage, int, error) {
	f.enrols = append(f.enrols, body)
	return json.RawMessage(`{"certificatePem":"issued"}`), http.StatusCreated, nil
}

func (f *fakeForwarder) AgentReport(_ context.Context, body json.RawMessage) (json.RawMessage, int, error) {
	f.reports = append(f.reports, body)
	return json.RawMessage(`{"runId":"r1"}`), http.StatusAccepted, nil
}

func certPEM(der []byte) []byte {
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
}

func keyPEM(t *testing.T, key *ecdsa.PrivateKey) []byte {
	t.Helper()
	der, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: der})
}

func issue(t *testing.T, template *x509.Certificate, parent *x509.Certificate, parentKey *ecdsa.PrivateKey) (*x509.Certificate, *ecdsa.PrivateKey) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	if parent == nil {
		parent = template
		parentKey = key
	}
	der, err := x509.CreateCertificate(rand.Reader, template, parent, &key.PublicKey, parentKey)
	if err != nil {
		t.Fatal(err)
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	return cert, key
}

func TestGateway(t *testing.T) {
	now := time.Now()
	ca, caKey := issue(t, &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "OpenMap Discovery CA"}, NotBefore: now, NotAfter: now.Add(time.Hour), IsCA: true, KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature, BasicConstraintsValid: true}, nil, nil)
	nodeCert, nodeKey := issue(t, &x509.Certificate{SerialNumber: big.NewInt(2), Subject: pkix.Name{CommonName: "node-ryd-02"}, NotBefore: now, NotAfter: now.Add(time.Hour), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth, x509.ExtKeyUsageClientAuth}, IPAddresses: []net.IP{net.ParseIP("127.0.0.1")}}, ca, caKey)
	agentCert, agentKey := issue(t, &x509.Certificate{SerialNumber: big.NewInt(3), Subject: pkix.Name{CommonName: "app-ryd-07.bank.local"}, NotBefore: now, NotAfter: now.Add(time.Hour), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}}, ca, caKey)

	dir := t.TempDir()
	caPath, certPath, keyPath := filepath.Join(dir, "ca.crt"), filepath.Join(dir, "node.crt"), filepath.Join(dir, "node.key")
	for path, data := range map[string][]byte{caPath: certPEM(ca.Raw), certPath: certPEM(nodeCert.Raw), keyPath: keyPEM(t, nodeKey)} {
		if err := os.WriteFile(path, data, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	forward := &fakeForwarder{}
	stored := map[string][]byte{}
	gw, err := New("127.0.0.1:0", caPath, certPath, keyPath, forward, func(_, digest string, data []byte) error { stored[digest] = data; return nil }, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	gw.server = &http.Server{Handler: gw.handler(), TLSConfig: gw.tlsConfig}
	go func() { _ = gw.server.ServeTLS(ln, "", "") }()
	defer gw.server.Close()
	base := "https://" + ln.Addr().String()

	pool := x509.NewCertPool()
	pool.AddCert(ca)
	anonymous := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}}}
	agentTLS := tls.Certificate{Certificate: [][]byte{agentCert.Raw}, PrivateKey: agentKey}
	asAgent := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: pool, Certificates: []tls.Certificate{agentTLS}, MinVersion: tls.VersionTLS12}}}

	// Enrolment needs no client certificate and is relayed verbatim.
	res, err := anonymous.Post(base+pathEnrol, "application/json", strings.NewReader(`{"agentId":"app-ryd-07.bank.local","token":"t","csrPem":"csr"}`))
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(res.Body)
	if res.StatusCode != http.StatusCreated || !bytes.Contains(body, []byte("issued")) || len(forward.enrols) != 1 {
		t.Fatalf("enrol relay wrong: %d %s", res.StatusCode, body)
	}

	// A report without a client certificate is refused before any forwarding.
	res, err = anonymous.Post(base+pathReport, "application/json", strings.NewReader(`{"cis":[]}`))
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != http.StatusUnauthorized || len(forward.reports) != 0 {
		t.Fatalf("anonymous report must be refused, got %d", res.StatusCode)
	}

	// With the agent certificate the gateway adds the identity and fingerprint before forwarding.
	res, err = asAgent.Post(base+pathReport, "application/json", strings.NewReader(`{"agentVersion":"0.1.0","cis":[],"raw":[{"kind":"agent_report","digest":"2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae","data":"foo"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != http.StatusAccepted || len(forward.reports) != 1 {
		t.Fatalf("agent report wrong: %d", res.StatusCode)
	}
	var forwarded map[string]any
	_ = json.Unmarshal(forward.reports[0], &forwarded)
	if forwarded["agentId"] != "app-ryd-07.bank.local" || forwarded["certificateFingerprint"] != Fingerprint(agentCert) || len(Fingerprint(agentCert)) != 64 {
		t.Fatalf("forwarded body wrong: %v", forwarded)
	}
	if _, leaked := forwarded["raw"]; leaked || string(stored["2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae"]) != "foo" {
		t.Fatalf("raw evidence must be stored on the Node and not forwarded: %v", forwarded)
	}

	// Claiming another identity in the body is rejected.
	res, err = asAgent.Post(base+pathReport, "application/json", strings.NewReader(`{"agentId":"someone-else","cis":[]}`))
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("mismatched agentId must be forbidden, got %d", res.StatusCode)
	}
}
