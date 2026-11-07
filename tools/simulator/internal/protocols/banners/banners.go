// REQ-QA-005 REQ-DISC-020 — TCP service personalities for simulated mode: each listener behaves on the wire
// like one service as a port scanner meets it. A greeting service (SSH) speaks first; a request/response
// service (HTTP, RTSP, SIP) stays quiet until the client sends something and then answers in its own protocol;
// a silent service (database listeners, proprietary agents) never sends a byte to an unauthenticated stranger;
// TLS personalities complete a handshake with a self-signed device certificate before any of that, as
// appliances do. Personalities are rendered from estate data by the caller.
package banners

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"math/big"
	"net"
	"strings"
	"sync"
	"time"
)

const (
	// sessionTimeout bounds how long a personality waits for a client that neither speaks nor hangs up.
	sessionTimeout = 10 * time.Second
	readBuffer     = 4096
	certLifetime   = 397 * 24 * time.Hour
	serialBits     = 62
	httpDate       = "Mon, 02 Jan 2006 15:04:05 GMT"
)

// Kind is how a personality behaves before authentication.
type Kind int

const (
	// Greeting services send Banner on connect (SSH, SMTP, FTP).
	Greeting Kind = iota
	// HTTP answers any request with a status line and its Server header.
	HTTP
	// RTSP answers any request with an RTSP/1.0 error (cameras on 554).
	RTSP
	// SIP answers any request with a SIP/2.0 error (phones and codecs on 5060/5061).
	SIP
	// Silent services read and never answer.
	Silent
)

// Personality is one service.
type Personality struct {
	Kind Kind
	// Banner is the greeting line (Greeting) or the Server / User-Agent product (HTTP, RTSP, SIP; "" omits it).
	Banner string
	// TLS completes a handshake with Cert before the service speaks.
	TLS  bool
	Cert *tls.Certificate
}

// SelfSigned issues a device certificate for commonName, as appliances generate on first boot.
func SelfSigned(commonName string) (*tls.Certificate, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	sn, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), serialBits))
	if err != nil {
		return nil, err
	}
	now := time.Now()
	tpl := &x509.Certificate{SerialNumber: sn, Subject: pkix.Name{CommonName: commonName}, NotBefore: now.Add(-time.Hour), NotAfter: now.Add(certLifetime),
		KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	if strings.Contains(commonName, ".") {
		tpl.DNSNames = []string{commonName}
	}
	der, err := x509.CreateCertificate(rand.Reader, tpl, tpl, &key.PublicKey, key)
	if err != nil {
		return nil, err
	}
	return &tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}, nil
}

func (p Personality) response(now time.Time) []byte {
	var b strings.Builder
	switch p.Kind {
	case HTTP:
		b.WriteString("HTTP/1.1 200 OK\r\n")
		b.WriteString("Date: " + now.UTC().Format(httpDate) + "\r\n")
		if p.Banner != "" {
			b.WriteString("Server: " + p.Banner + "\r\n")
		}
		b.WriteString("Content-Type: text/html\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
	case RTSP:
		b.WriteString("RTSP/1.0 400 Bad Request\r\nCSeq: 0\r\n")
		if p.Banner != "" {
			b.WriteString("Server: " + p.Banner + "\r\n")
		}
		b.WriteString("\r\n")
	case SIP:
		b.WriteString("SIP/2.0 400 Bad Request\r\n")
		if p.Banner != "" {
			b.WriteString("User-Agent: " + p.Banner + "\r\n")
		}
		b.WriteString("Content-Length: 0\r\n\r\n")
	}
	return []byte(b.String())
}

// Server is one running personality.
type Server struct {
	ln    net.Listener
	wg    sync.WaitGroup
	mu    sync.Mutex
	conns map[net.Conn]bool
}

// Serve runs p on ln until Close.
func Serve(ln net.Listener, p Personality) *Server {
	s := &Server{ln: ln, conns: map[net.Conn]bool{}}
	if p.TLS && p.Cert != nil {
		s.ln = tls.NewListener(ln, &tls.Config{Certificates: []tls.Certificate{*p.Cert}, MinVersion: tls.VersionTLS12})
	}
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		for {
			c, err := s.ln.Accept()
			if err != nil {
				return
			}
			s.mu.Lock()
			s.conns[c] = true
			s.mu.Unlock()
			s.wg.Add(1)
			go func() {
				defer s.wg.Done()
				defer func() { s.mu.Lock(); delete(s.conns, c); s.mu.Unlock() }()
				p.session(c)
			}()
		}
	}()
	return s
}

func (p Personality) session(c net.Conn) {
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(sessionTimeout))
	if p.Kind == Greeting {
		_, _ = c.Write([]byte(p.Banner + "\r\n"))
	}
	buf := make([]byte, readBuffer)
	n, err := c.Read(buf) // a TLS personality's handshake runs here, on the first read
	if err != nil || n == 0 {
		return
	}
	if r := p.response(time.Now()); len(r) > 0 {
		_, _ = c.Write(r)
		return
	}
	for { // silent and greeting services keep the connection open until the client gives up
		if _, err := c.Read(buf); err != nil {
			return
		}
	}
}

// Close stops the listener and its sessions.
func (s *Server) Close() error {
	err := s.ln.Close()
	s.mu.Lock()
	for c := range s.conns {
		_ = c.Close()
	}
	s.mu.Unlock()
	s.wg.Wait()
	return err
}
