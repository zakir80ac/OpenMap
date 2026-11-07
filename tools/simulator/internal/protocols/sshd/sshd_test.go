// T-365 REQ-QA-005 — the simulated SSH server: password and public-key authentication with the process
// credentials, wrong credentials refused, the presented host key matches the published fingerprint, exec replies
// carry stdout, stderr and the exit status, and the shell helpers undo sshexec's quoting and find every section.
package sshd

import (
	"bytes"
	"errors"
	"net"
	"strconv"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"

	"github.com/openmap/openmap/tools/simulator/internal/sim"
)

const testTimeout = 10 * time.Second

func dial(t *testing.T, s *Server, user string, auth ssh.AuthMethod) (*ssh.Client, string, error) {
	t.Helper()
	var seen string
	cfg := &ssh.ClientConfig{User: user, Auth: []ssh.AuthMethod{auth}, Timeout: testTimeout,
		HostKeyCallback: func(_ string, _ net.Addr, key ssh.PublicKey) error {
			seen = Fingerprint(key)
			return nil
		}}
	c, err := ssh.Dial("tcp", net.JoinHostPort(s.Host, strconv.Itoa(s.Port)), cfg)
	return c, seen, err
}

func run(t *testing.T, c *ssh.Client, cmd string) (string, string, int) {
	t.Helper()
	sess, err := c.NewSession()
	if err != nil {
		t.Fatal(err)
	}
	defer sess.Close()
	var out, errb bytes.Buffer
	sess.Stdout, sess.Stderr = &out, &errb
	status := 0
	if err := sess.Run(cmd); err != nil {
		var exit *ssh.ExitError
		if !errors.As(err, &exit) {
			t.Fatal(err)
		}
		status = exit.ExitStatus()
	}
	return out.String(), errb.String(), status
}

func TestSimulatedSSHServer(t *testing.T) {
	env, err := sim.NewEnv()
	if err != nil {
		t.Fatal(err)
	}
	privPEM, pub, err := ClientKey()
	if err != nil {
		t.Fatal(err)
	}
	s, err := Serve(env, func(r Request) Reply {
		if r.Command == "fail" {
			return Reply{Stderr: "boom\n", Status: 3}
		}
		return Reply{Stdout: r.User + ":" + r.Command}
	}, Config{AuthorizedKey: pub})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	c, seen, err := dial(t, s, env.User, ssh.Password(env.Secret))
	if err != nil {
		t.Fatal(err)
	}
	if seen != s.Fingerprint {
		t.Errorf("host key %s, published %s", seen, s.Fingerprint)
	}
	if out, _, status := run(t, c, "version"); out != env.User+":version" || status != 0 {
		t.Errorf("exec reply %q status %d", out, status)
	}
	if _, stderr, status := run(t, c, "fail"); stderr != "boom\n" || status != 3 {
		t.Errorf("failing exec %q status %d", stderr, status)
	}
	_ = c.Close()

	if _, _, err := dial(t, s, env.User, ssh.Password("wrong")); err == nil {
		t.Error("wrong password accepted")
	}
	signer, err := ssh.ParsePrivateKey([]byte(privPEM))
	if err != nil {
		t.Fatal(err)
	}
	kc, _, err := dial(t, s, env.User, ssh.PublicKeys(signer))
	if err != nil {
		t.Fatalf("public key auth: %v", err)
	}
	_ = kc.Close()
	otherPEM, _, err := ClientKey()
	if err != nil {
		t.Fatal(err)
	}
	otherSigner, err := ssh.ParsePrivateKey([]byte(otherPEM))
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := dial(t, s, env.User, ssh.PublicKeys(otherSigner)); err == nil {
		t.Error("unauthorised key accepted")
	}
	if len(s.Log()) == 0 {
		t.Error("request log is empty")
	}
}

func TestShellHelpers(t *testing.T) {
	script := "set +e;\nprintf '\\n@@OPENMAP:a@@\\n'; echo it's;\nfor u in $(x); do printf '\\n@@OPENMAP:dom:%s@@\\n' \"$u\"; done\n"
	quoted := "'" + strings.ReplaceAll(script, "'", `'\''`) + "'"
	got, ok := UnwrapShell("sh -c " + quoted)
	if !ok || got != script {
		t.Fatalf("unwrap: %v %q", ok, got)
	}
	secs := Sections(got)
	if len(secs) != 2 || secs[0].Key != "a" || secs[0].Templated() || !strings.Contains(secs[0].Command, "echo it's") {
		t.Fatalf("sections %+v", secs)
	}
	if !secs[1].Templated() || secs[1].Expand("u1") != "dom:u1" {
		t.Errorf("templated section %+v", secs[1])
	}
	if Frame("a", "x") != "\n@@OPENMAP:a@@\nx\n" {
		t.Errorf("frame %q", Frame("a", "x"))
	}
	if r := Shell(func(string) string { return "ok" })(Request{Command: "uname"}); r.Status != exitNotFound {
		t.Errorf("non-shell request %+v", r)
	}
}
