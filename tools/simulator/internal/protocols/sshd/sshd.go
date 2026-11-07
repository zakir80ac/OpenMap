// REQ-QA-005 REQ-DISC-003 REQ-DISC-007 REQ-DISC-015 REQ-DISC-016 REQ-DISC-022 — simulated-mode SSH server on the
// simulator bind address (golang.org/x/crypto/ssh): password authentication with the process credentials, optional public-key
// authentication for one authorised key, an ed25519 host key generated per server (collectors pin its
// fingerprint), and exec channels whose command string is answered by a vendor callback with stdout, stderr and
// an exit status. Interactive shells, PTYs, subsystems and forwarding are refused, as the collectors never ask.
package sshd

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/pem"
	"errors"
	"net"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"

	"github.com/openmap/openmap/tools/simulator/internal/sim"
)

const (
	// handshakeTimeout bounds a client that connects and never finishes key exchange.
	handshakeTimeout = 30 * time.Second
	// DefaultVersion is the identification string the server presents unless a vendor sets its own.
	DefaultVersion = "SSH-2.0-OpenSSH_9.6"
	channelSession = "session"
	reqExec        = "exec"
	reqExitStatus  = "exit-status"
)

// Request is one exec request as the client sent it.
type Request struct {
	User    string
	Command string
}

// Reply is what the simulated host prints for a request and the status the command exits with.
type Reply struct {
	Stdout string
	Stderr string
	Status uint32
}

// Handler answers exec requests.
type Handler func(Request) Reply

// Config tunes one server.
type Config struct {
	// Version is the server identification string (SSH-2.0-...).
	Version string
	// AuthorizedKey, when set, is accepted for public-key authentication as env.User.
	AuthorizedKey ssh.PublicKey
}

// Server is one simulated SSH daemon.
type Server struct {
	Host string
	Port int
	// Fingerprint is the host key fingerprint in OpenSSH SHA256 form, for the hostKeyFingerprints option.
	Fingerprint string

	ln      net.Listener
	handler Handler
	cfg     *ssh.ServerConfig
	mu      sync.Mutex
	conns   map[net.Conn]struct{}
	log     []string
	wg      sync.WaitGroup
	closed  bool
}

// Fingerprint renders a public key the way OpenSSH prints it (SHA256:base64, no padding).
func Fingerprint(key ssh.PublicKey) string {
	sum := sha256.Sum256(key.Marshal())
	return "SHA256:" + base64.RawStdEncoding.EncodeToString(sum[:])
}

// Serve starts a server on an ephemeral port at the simulator bind address (sim.Listen); Host is the advertised host.
func Serve(env *sim.Env, handler Handler, c Config) (*Server, error) {
	_, hostPriv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	signer, err := ssh.NewSignerFromKey(hostPriv)
	if err != nil {
		return nil, err
	}
	version := c.Version
	if version == "" {
		version = DefaultVersion
	}
	cfg := &ssh.ServerConfig{
		ServerVersion: version,
		PasswordCallback: func(meta ssh.ConnMetadata, password []byte) (*ssh.Permissions, error) {
			if meta.User() == env.User && string(password) == env.Secret {
				return &ssh.Permissions{}, nil
			}
			return nil, errors.New("permission denied")
		},
	}
	if c.AuthorizedKey != nil {
		want := c.AuthorizedKey.Marshal()
		cfg.PublicKeyCallback = func(meta ssh.ConnMetadata, key ssh.PublicKey) (*ssh.Permissions, error) {
			if meta.User() == env.User && string(key.Marshal()) == string(want) {
				return &ssh.Permissions{}, nil
			}
			return nil, errors.New("permission denied")
		}
	}
	cfg.AddHostKey(signer)
	ln, port, err := sim.Listen()
	if err != nil {
		return nil, err
	}
	s := &Server{Host: sim.AdvertiseHost(), Port: port, Fingerprint: Fingerprint(signer.PublicKey()), ln: ln, handler: handler, cfg: cfg, conns: map[net.Conn]struct{}{}}
	s.wg.Add(1)
	go s.accept()
	return s, nil
}

func (s *Server) accept() {
	defer s.wg.Done()
	for {
		conn, err := s.ln.Accept()
		if err != nil {
			return
		}
		s.mu.Lock()
		if s.closed {
			s.mu.Unlock()
			_ = conn.Close()
			return
		}
		s.conns[conn] = struct{}{}
		s.mu.Unlock()
		s.wg.Add(1)
		go func() {
			defer s.wg.Done()
			s.serveConn(conn)
			s.mu.Lock()
			delete(s.conns, conn)
			s.mu.Unlock()
			_ = conn.Close()
		}()
	}
}

func (s *Server) serveConn(conn net.Conn) {
	_ = conn.SetDeadline(time.Now().Add(handshakeTimeout))
	sc, chans, reqs, err := ssh.NewServerConn(conn, s.cfg)
	if err != nil {
		s.record("handshake failed: " + err.Error())
		return
	}
	_ = conn.SetDeadline(time.Time{})
	defer sc.Close()
	go ssh.DiscardRequests(reqs)
	var chWG sync.WaitGroup
	for nc := range chans {
		if nc.ChannelType() != channelSession {
			_ = nc.Reject(ssh.UnknownChannelType, "only session channels are served")
			continue
		}
		ch, creqs, err := nc.Accept()
		if err != nil {
			continue
		}
		chWG.Add(1)
		go func() {
			defer chWG.Done()
			s.serveSession(sc.User(), ch, creqs)
		}()
	}
	chWG.Wait()
}

func (s *Server) serveSession(user string, ch ssh.Channel, reqs <-chan *ssh.Request) {
	defer ch.Close()
	for req := range reqs {
		if req.Type != reqExec {
			// env, pty-req, shell, subsystem: a collector never needs them, and refusing keeps the server honest
			// about what it simulates.
			if req.WantReply {
				_ = req.Reply(false, nil)
			}
			continue
		}
		var payload struct{ Command string }
		if err := ssh.Unmarshal(req.Payload, &payload); err != nil {
			_ = req.Reply(false, nil)
			continue
		}
		_ = req.Reply(true, nil)
		s.record("exec " + firstLine(payload.Command))
		out := s.handler(Request{User: user, Command: payload.Command})
		if out.Stdout != "" {
			_, _ = ch.Write([]byte(out.Stdout))
		}
		if out.Stderr != "" {
			_, _ = ch.Stderr().Write([]byte(out.Stderr))
		}
		_ = ch.CloseWrite()
		_, _ = ch.SendRequest(reqExitStatus, false, ssh.Marshal(struct{ Status uint32 }{out.Status}))
		return
	}
}

func firstLine(s string) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return s[:i] + " ..."
	}
	return s
}

func (s *Server) record(entry string) {
	s.mu.Lock()
	s.log = append(s.log, entry)
	s.mu.Unlock()
}

// Log returns the exec requests and failed handshakes the server saw, oldest first.
func (s *Server) Log() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.log...)
}

// Close stops accepting, drops open connections and waits for their goroutines.
func (s *Server) Close() error {
	s.mu.Lock()
	s.closed = true
	for c := range s.conns {
		_ = c.Close()
	}
	s.mu.Unlock()
	err := s.ln.Close()
	s.wg.Wait()
	return err
}

// ClientKey generates an ed25519 key pair for ssh_key credentials: the OpenSSH-format private key PEM a collector
// credential carries, and the public key a server authorises.
func ClientKey() (string, ssh.PublicKey, error) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return "", nil, err
	}
	block, err := ssh.MarshalPrivateKey(priv, "")
	if err != nil {
		return "", nil, err
	}
	sshPub, err := ssh.NewPublicKey(pub)
	if err != nil {
		return "", nil, err
	}
	return string(pem.EncodeToMemory(block)), sshPub, nil
}
