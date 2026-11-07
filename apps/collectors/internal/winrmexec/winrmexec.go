// REQ-DISC-002 REQ-DISC-006 REQ-DISC-016 REQ-DISC-022 — shared WinRM runner for Windows collectors: NTLM
// (default), basic or Kerberos transport from the job, HTTP or HTTPS endpoint, one PowerShell script per target
// whose stdout is a single JSON document. Over HTTPS the listener certificate is verified (verifyTls) against the
// system pool or a private CA (caCertPem), optionally under the name the certificate carries (tlsServerName) when
// targets are addresses. Credentials arrive resolved from OpenBao and are never logged.
package winrmexec

import (
	"context"
	"crypto/x509"
	"encoding/base64"
	"fmt"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/masterzen/winrm"

	"github.com/openmap/openmap/apps/collectors/internal/collector"
	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

const (
	DefaultPortHTTP  = 5985
	DefaultPortHTTPS = 5986
	OptionPort       = "port"
	OptionTLS        = "useTls"
	OptionVerify     = "verifyTls"
	// OptionCA is a PEM bundle of the private CA that signed the WinRM HTTPS listener certificates; setting it
	// turns verification on against that pool.
	OptionCA = "caCertPem"
	// OptionServerName is the name verified on the listener certificate when targets are addresses and the
	// certificate carries a host or shared name rather than the address.
	OptionServerName = "tlsServerName"
	OptionAuth       = "auth" // ntlm | basic | kerberos
	OptionRealm      = "kerberosRealm"
	OptionSPN        = "kerberosSpn"
	OptionKrbConf    = "kerberosConfigPath"
	OptionTimeout    = "operationTimeoutSeconds"
	authNTLM         = "ntlm"
	authBasic        = "basic"
	authKerberos     = "kerberos"
	credUser         = "username"
	credPassword     = "password"
	credDomain       = "domain"
	defaultOpTimeout = 120 * time.Second
	envelopeSize     = 153600
	locale           = "en-US"
	exitAccessDenied = 5
)

// Output is one script run's result.
type Output struct {
	Stdout   string
	Stderr   string
	ExitCode int
}

// Run executes a PowerShell script on the target and returns its streams.
func Run(ctx context.Context, target contract.Target, cred *contract.Credential, options map[string]any, script string) (Output, error) {
	if cred == nil || cred.Type != "password" || cred.Fields[credUser] == "" {
		return Output{}, collector.Errorf(contract.ErrAuthFailed, false, "winrm requires a password credential with a username")
	}
	user := cred.Fields[credUser]
	if d := cred.Fields[credDomain]; d != "" && !strings.Contains(user, "\\") && !strings.Contains(user, "@") {
		user = d + "\\" + user
	}
	useTLS, _ := options[OptionTLS].(bool)
	verify := verifyOption(options)
	port := DefaultPortHTTP
	if useTLS {
		port = DefaultPortHTTPS
	}
	if p, ok := options[OptionPort]; ok {
		if n, ok := asInt(p); ok && n > 0 {
			port = n
		}
	}
	timeout := defaultOpTimeout
	if s, ok := options[OptionTimeout]; ok {
		if n, ok := asInt(s); ok && n > 0 {
			timeout = time.Duration(n) * time.Second
		}
	}
	endpoint, err := Endpoint(target, port, useTLS, options, timeout)
	if err != nil {
		return Output{}, err
	}
	params := winrm.NewParameters(isoDuration(timeout), locale, envelopeSize)
	auth, _ := options[OptionAuth].(string)
	switch strings.ToLower(auth) {
	case authBasic:
		// Basic: plain HTTP transport; only sensible over HTTPS.
	case authKerberos:
		realm, _ := options[OptionRealm].(string)
		spn, _ := options[OptionSPN].(string)
		krbConf, _ := options[OptionKrbConf].(string)
		proto := "http"
		if useTLS {
			proto = "https"
		}
		settings := &winrm.Settings{WinRMUsername: cred.Fields[credUser], WinRMPassword: cred.Fields[credPassword], WinRMHost: target.Value, WinRMPort: port, WinRMProto: proto, WinRMInsecure: !verify, KrbRealm: realm, KrbSpn: spn, KrbConfig: krbConf}
		params.TransportDecorator = func() winrm.Transporter { return winrm.NewClientKerberos(settings) }
	default:
		params.TransportDecorator = func() winrm.Transporter { return &winrm.ClientNTLM{} }
	}
	client, err := winrm.NewClientWithParameters(endpoint, user, cred.Fields[credPassword], params)
	if err != nil {
		return Output{}, collector.Errorf(contract.ErrInternal, false, "winrm client: %v", err)
	}
	stdout, stderr, code, err := client.RunPSWithContext(ctx, script)
	if err != nil {
		msg := err.Error()
		switch {
		case strings.Contains(msg, "401") || strings.Contains(strings.ToLower(msg), "unauthorized") || strings.Contains(strings.ToLower(msg), "authentication"):
			return Output{}, collector.Errorf(contract.ErrAuthFailed, false, "%s rejected the credential", target.Value)
		case ctx.Err() != nil || strings.Contains(strings.ToLower(msg), "timeout"):
			return Output{}, collector.Errorf(contract.ErrTimeout, true, "%s timed out", target.Value)
		default:
			return Output{}, collector.Errorf(contract.ErrUnreachable, true, "%s: %v", target.Value, err)
		}
	}
	if code == exitAccessDenied {
		return Output{Stdout: stdout, Stderr: stderr, ExitCode: code}, collector.Errorf(contract.ErrPermissionDenied, false, "%s: access denied running the collector script", target.Value)
	}
	return Output{Stdout: stdout, Stderr: stderr, ExitCode: code}, nil
}

func verifyOption(options map[string]any) bool {
	verify, _ := options[OptionVerify].(bool)
	ca, _ := options[OptionCA].(string)
	return verify || strings.TrimSpace(ca) != ""
}

// Endpoint builds the WinRM endpoint for a target: certificate verification follows verifyTls, a caCertPem
// pool replaces the system roots (and implies verification), and tlsServerName is the name checked on the
// listener certificate.
func Endpoint(target contract.Target, port int, useTLS bool, options map[string]any, timeout time.Duration) (*winrm.Endpoint, error) {
	var caPem []byte
	if ca, _ := options[OptionCA].(string); strings.TrimSpace(ca) != "" {
		if !x509.NewCertPool().AppendCertsFromPEM([]byte(ca)) {
			return nil, collector.Errorf(contract.ErrInternal, false, "%s option holds no PEM certificate", OptionCA)
		}
		caPem = []byte(ca)
	}
	endpoint := winrm.NewEndpoint(target.Value, port, useTLS, !verifyOption(options), caPem, nil, nil, timeout)
	if name, _ := options[OptionServerName].(string); strings.TrimSpace(name) != "" {
		endpoint.TLSServerName = strings.TrimSpace(name)
	}
	return endpoint, nil
}

// EncodedCommand renders a script as `powershell -EncodedCommand` (UTF-16LE base64), the form that
// survives WinRM quoting for scripts with quotes, pipes and here-strings.
func EncodedCommand(script string) string {
	u16 := utf16.Encode([]rune(script))
	b := make([]byte, 0, len(u16)*2)
	for _, r := range u16 {
		b = append(b, byte(r), byte(r>>8))
	}
	return "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand " + base64.StdEncoding.EncodeToString(b)
}

func isoDuration(d time.Duration) string {
	return fmt.Sprintf("PT%dS", int(d.Seconds()))
}

func asInt(v any) (int, bool) {
	switch n := v.(type) {
	case int:
		return n, true
	case float64:
		return int(n), true
	case string:
		var i int
		if _, err := fmt.Sscanf(n, "%d", &i); err == nil {
			return i, true
		}
	}
	return 0, false
}
