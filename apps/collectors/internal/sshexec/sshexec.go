// REQ-DISC-003 REQ-DISC-007 — shared SSH session runner for agentless collectors: credential to auth
// methods, host-key policy from the job (pinned fingerprint, trust-on-first-use recorded in the
// result, or strict), one exec round trip, and delimiter-based splitting of multi-command scripts.
package sshexec

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"net"
	"strconv"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"

	"github.com/openmap/openmap/apps/collectors/internal/collector"
	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

const (
	DefaultPort    = 22
	dialTimeout    = 10 * time.Second
	sessionTimeout = 120 * time.Second
	OptionPort     = "port"
	OptionHostKeys = "hostKeyFingerprints" // map[target]fingerprint, SHA256:base64
	OptionTOFU     = "trustOnFirstUse"
	credUser       = "username"
	credPassword   = "password"
	credPrivateKey = "privateKey"
	credPassphrase = "passphrase"
	delimiterOpen  = "@@OPENMAP:"
	delimiterClose = "@@"
)

// Output is what one script run returned.
type Output struct {
	Stdout  []byte
	Stderr  string
	HostKey string // SHA256 fingerprint of the host key that was presented
}

// Fingerprint renders a host key the way OpenSSH prints it.
func Fingerprint(key ssh.PublicKey) string {
	sum := sha256.Sum256(key.Marshal())
	return "SHA256:" + base64.RawStdEncoding.EncodeToString(sum[:])
}

// AuthMethods turns a password or ssh_key credential into SSH auth methods and the login user.
func AuthMethods(cred *contract.Credential) ([]ssh.AuthMethod, string, error) {
	if cred == nil {
		return nil, "", collector.Errorf(contract.ErrAuthFailed, false, "ssh requires a password or ssh_key credential")
	}
	user := cred.Fields[credUser]
	if user == "" {
		return nil, "", collector.Errorf(contract.ErrAuthFailed, false, "credential has no username")
	}
	switch cred.Type {
	case "password":
		return []ssh.AuthMethod{ssh.Password(cred.Fields[credPassword])}, user, nil
	case "ssh_key":
		pem := []byte(cred.Fields[credPrivateKey])
		var signer ssh.Signer
		var err error
		if pass := cred.Fields[credPassphrase]; pass != "" {
			signer, err = ssh.ParsePrivateKeyWithPassphrase(pem, []byte(pass))
		} else {
			signer, err = ssh.ParsePrivateKey(pem)
		}
		if err != nil {
			return nil, "", collector.Errorf(contract.ErrAuthFailed, false, "private key: %v", err)
		}
		return []ssh.AuthMethod{ssh.PublicKeys(signer)}, user, nil
	default:
		return nil, "", collector.Errorf(contract.ErrAuthFailed, false, "unsupported credential type %q for ssh", cred.Type)
	}
}

// HostKeyCallback enforces the job's host-key policy and records the fingerprint it saw.
func HostKeyCallback(target contract.Target, options map[string]any, seen *string) ssh.HostKeyCallback {
	pinned := ""
	if m, ok := options[OptionHostKeys].(map[string]any); ok {
		if v, ok := m[target.Value].(string); ok {
			pinned = v
		}
	}
	tofu, _ := options[OptionTOFU].(bool)
	return func(_ string, _ net.Addr, key ssh.PublicKey) error {
		fp := Fingerprint(key)
		*seen = fp
		if pinned != "" {
			if fp != pinned {
				return fmt.Errorf("host key mismatch: got %s want %s", fp, pinned)
			}
			return nil
		}
		if tofu {
			return nil
		}
		return fmt.Errorf("no pinned host key for %s and trust-on-first-use is off (fingerprint %s)", target.Value, fp)
	}
}

// Port reads the port option or returns the SSH default.
func Port(options map[string]any) int {
	if p, ok := options[OptionPort]; ok {
		if n, err := strconv.Atoi(fmt.Sprint(p)); err == nil && n > 0 {
			return n
		}
	}
	return DefaultPort
}

// Run opens one SSH session to the target and executes the script under `sh -c`.
func Run(ctx context.Context, target contract.Target, cred *contract.Credential, options map[string]any, script string) (Output, error) {
	methods, user, err := AuthMethods(cred)
	if err != nil {
		return Output{}, err
	}
	var seenKey string
	cfg := &ssh.ClientConfig{User: user, Auth: methods, HostKeyCallback: HostKeyCallback(target, options, &seenKey), Timeout: dialTimeout}
	dialer := net.Dialer{Timeout: dialTimeout}
	conn, err := dialer.DialContext(ctx, "tcp", net.JoinHostPort(target.Value, strconv.Itoa(Port(options))))
	if err != nil {
		return Output{}, collector.Errorf(contract.ErrUnreachable, true, "dial %s: %v", target.Value, err)
	}
	defer conn.Close()
	if dl, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(dl)
	} else {
		_ = conn.SetDeadline(time.Now().Add(sessionTimeout))
	}
	c, chans, reqs, err := ssh.NewClientConn(conn, target.Value, cfg)
	if err != nil {
		msg := err.Error()
		if strings.Contains(msg, "host key") {
			return Output{HostKey: seenKey}, collector.Errorf(contract.ErrPermissionDenied, false, "%v", err)
		}
		if strings.Contains(msg, "unable to authenticate") || strings.Contains(msg, "no supported methods") {
			return Output{HostKey: seenKey}, collector.Errorf(contract.ErrAuthFailed, false, "%s rejected the credential", target.Value)
		}
		return Output{HostKey: seenKey}, collector.Errorf(contract.ErrUnreachable, true, "%s: %v", target.Value, err)
	}
	client := ssh.NewClient(c, chans, reqs)
	defer client.Close()
	session, err := client.NewSession()
	if err != nil {
		return Output{HostKey: seenKey}, collector.Errorf(contract.ErrInternal, true, "session: %v", err)
	}
	defer session.Close()
	var stdout, stderr bytes.Buffer
	session.Stdout = &stdout
	session.Stderr = &stderr
	if err := session.Run("sh -c " + ShellQuote(script)); err != nil && stdout.Len() == 0 {
		return Output{Stderr: stderr.String(), HostKey: seenKey}, collector.Errorf(contract.ErrParse, false, "script failed on %s: %v %s", target.Value, err, stderr.String())
	}
	return Output{Stdout: stdout.Bytes(), Stderr: stderr.String(), HostKey: seenKey}, nil
}

// Exec opens one SSH connection and runs each command in its own exec channel, which is how
// network operating systems (FOS, NX-OS, IOS-XE, EOS, Junos) accept commands without a shell.
// Output is keyed by command; a command that fails yields its stderr text under the same key.
func Exec(ctx context.Context, target contract.Target, cred *contract.Credential, options map[string]any, commands []string) (map[string]string, string, error) {
	methods, user, err := AuthMethods(cred)
	if err != nil {
		return nil, "", err
	}
	var seenKey string
	cfg := &ssh.ClientConfig{User: user, Auth: methods, HostKeyCallback: HostKeyCallback(target, options, &seenKey), Timeout: dialTimeout}
	dialer := net.Dialer{Timeout: dialTimeout}
	conn, err := dialer.DialContext(ctx, "tcp", net.JoinHostPort(target.Value, strconv.Itoa(Port(options))))
	if err != nil {
		return nil, "", collector.Errorf(contract.ErrUnreachable, true, "dial %s: %v", target.Value, err)
	}
	defer conn.Close()
	if dl, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(dl)
	} else {
		_ = conn.SetDeadline(time.Now().Add(sessionTimeout))
	}
	c, chans, reqs, err := ssh.NewClientConn(conn, target.Value, cfg)
	if err != nil {
		msg := err.Error()
		if strings.Contains(msg, "host key") {
			return nil, seenKey, collector.Errorf(contract.ErrPermissionDenied, false, "%v", err)
		}
		if strings.Contains(msg, "unable to authenticate") || strings.Contains(msg, "no supported methods") {
			return nil, seenKey, collector.Errorf(contract.ErrAuthFailed, false, "%s rejected the credential", target.Value)
		}
		return nil, seenKey, collector.Errorf(contract.ErrUnreachable, true, "%s: %v", target.Value, err)
	}
	client := ssh.NewClient(c, chans, reqs)
	defer client.Close()
	out := make(map[string]string, len(commands))
	for _, cmd := range commands {
		session, err := client.NewSession()
		if err != nil {
			return out, seenKey, collector.Errorf(contract.ErrInternal, true, "session: %v", err)
		}
		var stdout, stderr bytes.Buffer
		session.Stdout = &stdout
		session.Stderr = &stderr
		runErr := session.Run(cmd)
		_ = session.Close()
		if runErr != nil && stdout.Len() == 0 {
			out[cmd] = strings.TrimSpace(stderr.String())
			continue
		}
		out[cmd] = stdout.String()
	}
	return out, seenKey, nil
}

// ShellQuote single-quotes a string for a POSIX shell.
func ShellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// Marker is the delimiter line a script prints before each command's output.
func Marker(key string) string {
	return delimiterOpen + key + delimiterClose
}

// MarkerPrintf is the shell fragment printing Marker(key) on its own line.
func MarkerPrintf(key string) string {
	return "printf '\\n" + Marker(key) + "\\n'"
}

// Split turns delimited output back into per-key text, in the order the markers appeared.
func Split(output string) (map[string]string, []string) {
	out := map[string]string{}
	var order []string
	key := ""
	var buf strings.Builder
	flush := func() {
		if key != "" {
			out[key] = strings.TrimRight(buf.String(), "\n")
			order = append(order, key)
		}
		buf.Reset()
	}
	for _, line := range strings.Split(output, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, delimiterOpen) && strings.HasSuffix(trimmed, delimiterClose) {
			flush()
			key = strings.TrimSuffix(strings.TrimPrefix(trimmed, delimiterOpen), delimiterClose)
			continue
		}
		if key != "" {
			buf.WriteString(line)
			buf.WriteByte('\n')
		}
	}
	flush()
	return out, order
}
