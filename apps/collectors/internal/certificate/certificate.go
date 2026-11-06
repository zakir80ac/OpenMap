// REQ-DISC-025 — TLS certificate collector: handshakes with each target endpoint (host:port, SNI
// from the job or the host name), records the leaf and presented chain, and emits certificate CIs
// with expiry, key and issuer facts plus the listening service they secure. Verification result
// against the system roots is recorded, never enforced, so self-signed inventory still lands.
package certificate

import (
	"context"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"net"
	"strconv"
	"strings"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/collector"
	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

const (
	collectorID    = "certificate"
	version        = "0.1.0"
	evidenceKind   = "api_response"
	defaultPort    = 443
	dialTimeout    = 10 * time.Second
	optionPorts    = "ports"
	optionSNI      = "serverName"
	optionStartTLS = "startTls" // smtp | imap | pop3 | ldap | postgres | auto/true (by port); direct TLS when empty (starttls.go)
	hoursPerDay    = 24

	typeCertificate = "certificate"
	typeListener    = "listening_service"
	relSecuredBy    = "secured_by"
	relDependsOn    = "depends_on"
)

type Collector struct{}

func (Collector) Manifest() contract.Manifest {
	return contract.Manifest{
		ID: collectorID, Family: "certificate", Version: version, Language: "go",
		Protocols: []string{"tls", StartTLSSMTP, StartTLSIMAP, StartTLSPOP3, StartTLSLDAP, StartTLSPostgres}, CredentialTypes: []string{"none"},
		TargetKinds: []string{"host", "url"}, Emits: []string{typeCertificate, typeListener},
		ContractVersion: contract.Version,
	}
}

// Endpoint is one host:port handshake result.
type Endpoint struct {
	Host       string
	Port       int
	ServerName string
	StartTLS   string // protocol negotiated in plaintext before the handshake; empty for direct TLS
	Version    string
	Cipher     string
	Chain      []*x509.Certificate
	Verified   bool
	VerifyErr  string
	Error      string
}

func tlsVersion(v uint16) string {
	switch v {
	case tls.VersionTLS13:
		return "TLS 1.3"
	case tls.VersionTLS12:
		return "TLS 1.2"
	case tls.VersionTLS11:
		return "TLS 1.1"
	case tls.VersionTLS10:
		return "TLS 1.0"
	default:
		return "unknown"
	}
}

// Probe performs one direct-TLS handshake and returns the presented chain without failing on untrusted roots.
func Probe(ctx context.Context, host string, port int, serverName string) Endpoint {
	return ProbeStartTLS(ctx, host, port, serverName, "")
}

// ProbeStartTLS is Probe for services that upgrade in-band: the plaintext StartTLS dialogue of
// protocol (see starttls.go) runs first, then the same handshake and chain recording. An empty
// protocol is direct TLS.
func ProbeStartTLS(ctx context.Context, host string, port int, serverName, protocol string) Endpoint {
	ep := Endpoint{Host: host, Port: port, ServerName: serverName, StartTLS: protocol}
	dialer := &net.Dialer{Timeout: dialTimeout}
	raw, err := dialer.DialContext(ctx, "tcp", net.JoinHostPort(host, strconv.Itoa(port)))
	if err != nil {
		ep.Error = err.Error()
		return ep
	}
	defer raw.Close()
	_ = raw.SetDeadline(time.Now().Add(dialTimeout))
	if protocol != "" {
		if err := negotiateStartTLS(raw, protocol); err != nil {
			ep.Error = err.Error()
			return ep
		}
	}
	cfg := &tls.Config{ServerName: serverName, InsecureSkipVerify: true, MinVersion: tls.VersionTLS10} //nolint:gosec // inventory collector: the chain is recorded and verified separately below.
	conn := tls.Client(raw, cfg)
	if err := conn.HandshakeContext(ctx); err != nil {
		ep.Error = err.Error()
		return ep
	}
	state := conn.ConnectionState()
	ep.Version = tlsVersion(state.Version)
	ep.Cipher = tls.CipherSuiteName(state.CipherSuite)
	ep.Chain = state.PeerCertificates
	if len(ep.Chain) > 0 {
		opts := x509.VerifyOptions{DNSName: serverName, Intermediates: x509.NewCertPool()}
		for _, c := range ep.Chain[1:] {
			opts.Intermediates.AddCert(c)
		}
		if _, err := ep.Chain[0].Verify(opts); err != nil {
			ep.VerifyErr = err.Error()
		} else {
			ep.Verified = true
		}
	}
	return ep
}

func fingerprint(c *x509.Certificate) string {
	sum := sha256.Sum256(c.Raw)
	return hex.EncodeToString(sum[:])
}

func keyInfo(c *x509.Certificate) (string, int) {
	switch k := c.PublicKey.(type) {
	case *rsa.PublicKey:
		return "RSA", k.N.BitLen()
	case *ecdsa.PublicKey:
		return "ECDSA", k.Curve.Params().BitSize
	case ed25519.PublicKey:
		return "Ed25519", len(k) * 8
	default:
		return c.PublicKeyAlgorithm.String(), 0
	}
}

// Facts is the JSON evidence recorded per certificate (DER is not stored; the fingerprint is).
type Facts struct {
	Subject      string    `json:"subject"`
	Issuer       string    `json:"issuer"`
	Serial       string    `json:"serial"`
	NotBefore    time.Time `json:"notBefore"`
	NotAfter     time.Time `json:"notAfter"`
	DNSNames     []string  `json:"dnsNames"`
	IPAddresses  []string  `json:"ipAddresses"`
	KeyAlgorithm string    `json:"keyAlgorithm"`
	KeyBits      int       `json:"keyBits"`
	Signature    string    `json:"signatureAlgorithm"`
	IsCA         bool      `json:"isCa"`
	SelfSigned   bool      `json:"selfSigned"`
	Fingerprint  string    `json:"fingerprintSha256"`
}

func facts(c *x509.Certificate) Facts {
	alg, bits := keyInfo(c)
	ips := []string{}
	for _, ip := range c.IPAddresses {
		ips = append(ips, ip.String())
	}
	return Facts{
		Subject: c.Subject.String(), Issuer: c.Issuer.String(), Serial: c.SerialNumber.Text(16), NotBefore: c.NotBefore.UTC(), NotAfter: c.NotAfter.UTC(),
		DNSNames: append([]string{}, c.DNSNames...), IPAddresses: ips, KeyAlgorithm: alg, KeyBits: bits, Signature: c.SignatureAlgorithm.String(),
		IsCA: c.IsCA, SelfSigned: c.Subject.String() == c.Issuer.String(), Fingerprint: fingerprint(c),
	}
}

// Emit converts handshake results into observations. Issuer certificates become their own CIs
// linked with depends_on so one expiring intermediate shows every leaf it affects.
func Emit(endpoints []Endpoint, target contract.Target, at time.Time) collector.Observation {
	obs := collector.Observation{}
	seen := map[string]bool{}
	for _, ep := range endpoints {
		if len(ep.Chain) == 0 {
			continue
		}
		var prevRef *contract.CiRef
		for depth, c := range ep.Chain {
			f := facts(c)
			if raw, err := json.Marshal(f); err == nil {
				obs.Evidence = append(obs.Evidence, collector.RawEvidence{Kind: evidenceKind, Data: raw})
			}
			identity := map[string]string{"fingerprintSha256": f.Fingerprint}
			ref := contract.CiRef{Type: typeCertificate, Identity: identity}
			if !seen[f.Fingerprint] {
				seen[f.Fingerprint] = true
				daysLeft := int(time.Until(f.NotAfter).Hours() / hoursPerDay)
				name := c.Subject.CommonName
				if name == "" && len(c.DNSNames) > 0 {
					name = c.DNSNames[0]
				}
				if name == "" {
					name = f.Subject
				}
				obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeCertificate, Identity: identity, Name: name,
					Attributes: map[string]any{"subject": f.Subject, "issuer": f.Issuer, "serial": f.Serial, "notBefore": f.NotBefore.Format(time.RFC3339), "notAfter": f.NotAfter.Format(time.RFC3339), "daysToExpiry": daysLeft, "expired": daysLeft < 0,
						"dnsNames": f.DNSNames, "ipAddresses": f.IPAddresses, "keyAlgorithm": f.KeyAlgorithm, "keyBits": f.KeyBits, "signatureAlgorithm": f.Signature, "isCa": f.IsCA, "selfSigned": f.SelfSigned, "chainDepth": depth, "fingerprintSha256": f.Fingerprint},
					Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
			}
			if prevRef != nil {
				obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relDependsOn, From: *prevRef, To: ref, Attributes: map[string]any{"role": "issuer"}, ObservedAt: at})
			}
			p := ref
			prevRef = &p
		}
		leaf := contract.CiRef{Type: typeCertificate, Identity: map[string]string{"fingerprintSha256": fingerprint(ep.Chain[0])}}
		lsIdentity := map[string]string{"hostRef": ep.Host, "protocol": "tcp", "port": strconv.Itoa(ep.Port)}
		lsName := "tcp/" + strconv.Itoa(ep.Port) + " tls"
		if ep.StartTLS != "" {
			lsName = "tcp/" + strconv.Itoa(ep.Port) + " " + ep.StartTLS + " starttls"
		}
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeListener, Identity: lsIdentity, Name: lsName,
			Attributes: map[string]any{"protocol": "tcp", "port": ep.Port, "tls": true, "startTls": ep.StartTLS, "tlsVersion": ep.Version, "cipherSuite": ep.Cipher, "serverName": ep.ServerName, "chainVerified": ep.Verified, "chainVerifyError": ep.VerifyErr, "target": target.Value},
			Tags:       []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
		obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relSecuredBy, From: contract.CiRef{Type: typeListener, Identity: lsIdentity}, To: leaf, Attributes: map[string]any{}, ObservedAt: at})
	}
	return obs
}

func ports(options map[string]any) []int {
	out := []int{}
	if list, ok := options[optionPorts].([]any); ok {
		for _, p := range list {
			switch v := p.(type) {
			case float64:
				out = append(out, int(v))
			case int:
				out = append(out, v)
			case string:
				if n, err := strconv.Atoi(v); err == nil {
					out = append(out, n)
				}
			}
		}
	}
	if len(out) == 0 {
		out = append(out, defaultPort)
	}
	return out
}

// splitTarget accepts "host", "host:port" or "https://host:port/…".
func splitTarget(value string) (string, int, bool) {
	v := value
	if i := strings.Index(v, "://"); i >= 0 {
		v = v[i+len("://"):]
		if j := strings.Index(v, "/"); j >= 0 {
			v = v[:j]
		}
	}
	host, port, err := net.SplitHostPort(v)
	if err != nil {
		return v, 0, false
	}
	n, err := strconv.Atoi(port)
	if err != nil {
		return host, 0, false
	}
	return host, n, true
}

func (Collector) Collect(ctx context.Context, target contract.Target, _ *contract.Credential, options map[string]any) (collector.Observation, error) {
	host, explicitPort, hasPort := splitTarget(target.Value)
	sni, _ := options[optionSNI].(string)
	if sni == "" && net.ParseIP(host) == nil {
		sni = host
	}
	list := ports(options)
	if hasPort {
		list = []int{explicitPort}
	}
	var endpoints []Endpoint
	failures := 0
	for _, p := range list {
		startTLS, err := StartTLSProtocol(options[optionStartTLS], p)
		if err != nil {
			return collector.Observation{}, collector.Errorf(contract.ErrUnsupportedDevice, false, "%s: %v", target.Value, err)
		}
		ep := ProbeStartTLS(ctx, host, p, sni, startTLS)
		if ep.Error != "" {
			failures++
		}
		endpoints = append(endpoints, ep)
	}
	if failures == len(list) {
		return collector.Observation{}, collector.Errorf(contract.ErrUnreachable, true, "%s: no TLS endpoint answered (%s)", target.Value, endpoints[0].Error)
	}
	return Emit(endpoints, target, time.Now().UTC()), nil
}
