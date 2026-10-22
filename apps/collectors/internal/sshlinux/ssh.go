// REQ-DISC-003 — agentless SSH collector for Linux and Unix hosts: one session, one script, host
// key policy from the job (pinned fingerprint, trust-on-first-use recorded in the result, or strict).
package sshlinux

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
	collectorID    = "ssh_agentless"
	version        = "0.1.0"
	defaultPort    = 22
	dialTimeout    = 10 * time.Second
	sessionTimeout = 120 * time.Second
	optionPort     = "port"
	optionHostKeys = "hostKeyFingerprints" // map[target]fingerprint, SHA256:base64
	optionTOFU     = "trustOnFirstUse"
	credUser       = "username"
	credPassword   = "password"
	credPrivateKey = "privateKey"
	credPassphrase = "passphrase"
	attrHostKey    = "sshHostKeySha256"
)

type Collector struct{}

func (Collector) Manifest() contract.Manifest {
	return contract.Manifest{
		ID: collectorID, Family: "ssh_agentless", Version: version, Language: "go",
		Protocols: []string{"ssh"}, CredentialTypes: []string{"password", "ssh_key"},
		TargetKinds: []string{"host"}, Emits: []string{typeHost, typeVM, typeOS, typeInterface, typeIP, typeListener, typeSoftware, typeInstall},
		ContractVersion: contract.Version,
	}
}

func fingerprint(key ssh.PublicKey) string {
	sum := sha256.Sum256(key.Marshal())
	return "SHA256:" + base64.RawStdEncoding.EncodeToString(sum[:])
}

func authMethods(cred *contract.Credential) ([]ssh.AuthMethod, string, error) {
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

func hostKeyCallback(target contract.Target, options map[string]any, seen *string) (ssh.HostKeyCallback, error) {
	pinned := ""
	if m, ok := options[optionHostKeys].(map[string]any); ok {
		if v, ok := m[target.Value].(string); ok {
			pinned = v
		}
	}
	tofu, _ := options[optionTOFU].(bool)
	return func(_ string, _ net.Addr, key ssh.PublicKey) error {
		fp := fingerprint(key)
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
	}, nil
}

func (Collector) Collect(ctx context.Context, target contract.Target, cred *contract.Credential, options map[string]any) (collector.Observation, error) {
	methods, user, err := authMethods(cred)
	if err != nil {
		return collector.Observation{}, err
	}
	port := defaultPort
	if p, ok := options[optionPort]; ok {
		if n, err := strconv.Atoi(fmt.Sprint(p)); err == nil && n > 0 {
			port = n
		}
	}
	var seenKey string
	hkc, err := hostKeyCallback(target, options, &seenKey)
	if err != nil {
		return collector.Observation{}, err
	}
	cfg := &ssh.ClientConfig{User: user, Auth: methods, HostKeyCallback: hkc, Timeout: dialTimeout}
	dialer := net.Dialer{Timeout: dialTimeout}
	conn, err := dialer.DialContext(ctx, "tcp", net.JoinHostPort(target.Value, strconv.Itoa(port)))
	if err != nil {
		return collector.Observation{}, collector.Errorf(contract.ErrUnreachable, true, "dial %s: %v", target.Value, err)
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
			return collector.Observation{}, collector.Errorf(contract.ErrPermissionDenied, false, "%v", err)
		}
		if strings.Contains(msg, "unable to authenticate") || strings.Contains(msg, "no supported methods") {
			return collector.Observation{}, collector.Errorf(contract.ErrAuthFailed, false, "%s rejected the credential", target.Value)
		}
		return collector.Observation{}, collector.Errorf(contract.ErrUnreachable, true, "%s: %v", target.Value, err)
	}
	client := ssh.NewClient(c, chans, reqs)
	defer client.Close()
	session, err := client.NewSession()
	if err != nil {
		return collector.Observation{}, collector.Errorf(contract.ErrInternal, true, "session: %v", err)
	}
	defer session.Close()
	var stdout, stderr bytes.Buffer
	session.Stdout = &stdout
	session.Stderr = &stderr
	if err := session.Run("sh -c " + shellQuote(Script())); err != nil && stdout.Len() == 0 {
		return collector.Observation{}, collector.Errorf(contract.ErrParse, false, "script failed on %s: %v %s", target.Value, err, stderr.String())
	}
	at := time.Now().UTC()
	facts := Assemble(Split(stdout.String()))
	obs := Emit(facts, target, stdout.Bytes(), at)
	if len(obs.Cis) > 0 && seenKey != "" {
		obs.Cis[0].Attributes[attrHostKey] = seenKey
	}
	return obs, nil
}

func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}
