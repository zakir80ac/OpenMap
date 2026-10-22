// REQ-DISC-004 — the Node's agent gateway: an HTTPS listener that host agents at the site talk to.
// It serves the Node's own mTLS certificate, trusts the scheduler CA for agent client certificates,
// and forwards two calls to the scheduler as the Node: enrolment (no client certificate yet; the
// one-time token is the proof) and reports (client certificate required; its SHA-256 fingerprint is
// passed on so the scheduler can match it to the enrolled agent). Agents never reach the scheduler
// directly, so branch sites expose one address and one certificate.
package agentgw

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

const (
	pathEnrol       = "/v1/agents/enrol"
	pathReport      = "/v1/agents/report"
	pathHealth      = "/healthz"
	maxBodyBytes    = 64 << 20 // an inventory report with software and listeners of a large host
	readTimeout     = 60 * time.Second
	writeTimeout    = 60 * time.Second
	idleTimeout     = 120 * time.Second
	shutdownGrace   = 10 * time.Second
	headerContract  = "X-OpenMap-Contract"
	digestPrefixLen = 2
	dirMode         = 0o750
	fileMode        = 0o640
)

// Forwarder is the scheduler-facing side: the Node's authenticated transport client implements it.
type Forwarder interface {
	AgentEnrol(ctx context.Context, body json.RawMessage) (json.RawMessage, int, error)
	AgentReport(ctx context.Context, body json.RawMessage) (json.RawMessage, int, error)
}

// EvidenceStore keeps the raw bytes an agent attached to its report, by digest, like collector evidence.
type EvidenceStore func(kind, digest string, data []byte) error

// FileStore writes raw evidence under <dir>/<kind>/<digest[:2]>/<digest>, the content-addressed layout the
// collector supervisor uses, so agent and collector evidence sit side by side.
func FileStore(dir string) EvidenceStore {
	return func(kind, digest string, data []byte) error {
		if dir == "" || len(digest) < digestPrefixLen {
			return errors.New("evidence directory or digest missing")
		}
		target := filepath.Join(dir, kind, digest[:digestPrefixLen])
		if err := os.MkdirAll(target, dirMode); err != nil {
			return err
		}
		return os.WriteFile(filepath.Join(target, digest), data, fileMode)
	}
}

// Gateway is the listener.
type Gateway struct {
	addr      string
	tlsConfig *tls.Config
	forward   Forwarder
	store     EvidenceStore
	log       *slog.Logger
	server    *http.Server
}

// New loads the Node certificate and the CA, and builds the listener configuration. store may be nil when the Node
// keeps no evidence directory; raw evidence is then dropped and only the digests travel on.
func New(addr, caPath, certPath, keyPath string, forward Forwarder, store EvidenceStore, log *slog.Logger) (*Gateway, error) {
	cert, err := tls.LoadX509KeyPair(certPath, keyPath)
	if err != nil {
		return nil, err
	}
	caPem, err := os.ReadFile(caPath)
	if err != nil {
		return nil, err
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(caPem) {
		return nil, errors.New("agent gateway: CA file holds no certificate")
	}
	cfg := &tls.Config{
		Certificates: []tls.Certificate{cert},
		ClientCAs:    pool,
		// Enrolment arrives without a certificate; reports are refused without one by the handler.
		ClientAuth: tls.VerifyClientCertIfGiven,
		MinVersion: tls.VersionTLS12,
	}
	return &Gateway{addr: addr, tlsConfig: cfg, forward: forward, store: store, log: log}, nil
}

// Fingerprint is the lowercase hex SHA-256 of a certificate's DER encoding, the form the scheduler stores.
func Fingerprint(cert *x509.Certificate) string {
	sum := sha256.Sum256(cert.Raw)
	return hex.EncodeToString(sum[:])
}

func (g *Gateway) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc(pathHealth, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	})
	mux.HandleFunc(pathEnrol, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		body, err := io.ReadAll(io.LimitReader(r.Body, maxBodyBytes))
		if err != nil || !json.Valid(body) {
			http.Error(w, "body must be JSON", http.StatusBadRequest)
			return
		}
		out, status, err := g.forward.AgentEnrol(r.Context(), body)
		g.respond(w, out, status, err, "enrol")
	})
	mux.HandleFunc(pathReport, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if r.TLS == nil || len(r.TLS.PeerCertificates) == 0 {
			http.Error(w, "an agent client certificate is required", http.StatusUnauthorized)
			return
		}
		peer := r.TLS.PeerCertificates[0]
		if time.Now().After(peer.NotAfter) {
			http.Error(w, "agent certificate expired", http.StatusUnauthorized)
			return
		}
		body, err := io.ReadAll(io.LimitReader(r.Body, maxBodyBytes))
		if err != nil {
			http.Error(w, "body unreadable", http.StatusBadRequest)
			return
		}
		var report map[string]json.RawMessage
		if err := json.Unmarshal(body, &report); err != nil {
			http.Error(w, "body must be a JSON object", http.StatusBadRequest)
			return
		}
		// The certificate is the identity: the agentId in the body must be the certificate CN, and the fingerprint is ours to add.
		var claimed string
		if raw, ok := report["agentId"]; ok {
			_ = json.Unmarshal(raw, &claimed)
		}
		if claimed != "" && claimed != peer.Subject.CommonName {
			http.Error(w, "agentId does not match the certificate", http.StatusForbidden)
			return
		}
		cn, _ := json.Marshal(peer.Subject.CommonName)
		fp, _ := json.Marshal(Fingerprint(peer))
		report["agentId"] = cn
		report["certificateFingerprint"] = fp
		// Raw evidence stays on the Node under its digest (the scheduler receives the digest records only), the
		// same place collector evidence lives, so the console's evidence links resolve for agent reports too.
		if rawList, ok := report["raw"]; ok {
			var items []struct {
				Kind   string `json:"kind"`
				Digest string `json:"digest"`
				Data   string `json:"data"`
			}
			if err := json.Unmarshal(rawList, &items); err == nil && g.store != nil {
				for _, item := range items {
					sum := sha256.Sum256([]byte(item.Data))
					if hex.EncodeToString(sum[:]) != item.Digest {
						http.Error(w, "raw evidence digest mismatch", http.StatusBadRequest)
						return
					}
					if err := g.store(item.Kind, item.Digest, []byte(item.Data)); err != nil {
						g.log.Warn("agent evidence not stored", "digest", item.Digest, "err", err)
					}
				}
			}
			delete(report, "raw")
		}
		forwardBody, _ := json.Marshal(report)
		out, status, err := g.forward.AgentReport(r.Context(), forwardBody)
		g.respond(w, out, status, err, "report")
	})
	return mux
}

func (g *Gateway) respond(w http.ResponseWriter, out json.RawMessage, status int, err error, what string) {
	if err != nil {
		g.log.Warn("agent gateway forward failed", "call", what, "err", err)
		http.Error(w, "scheduler unavailable", http.StatusBadGateway)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(out)
}

// Serve listens until ctx ends.
func (g *Gateway) Serve(ctx context.Context) error {
	ln, err := net.Listen("tcp", g.addr)
	if err != nil {
		return err
	}
	g.server = &http.Server{Handler: g.handler(), TLSConfig: g.tlsConfig, ReadTimeout: readTimeout, WriteTimeout: writeTimeout, IdleTimeout: idleTimeout}
	errCh := make(chan error, 1)
	go func() { errCh <- g.server.ServeTLS(ln, "", "") }()
	g.log.Info("agent gateway listening", "addr", ln.Addr().String())
	select {
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownGrace)
		defer cancel()
		return g.server.Shutdown(shutdownCtx)
	case err := <-errCh:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	}
}

// Addr reports the bound address once Serve has started (tests bind port 0).
func (g *Gateway) Addr() string {
	if g.server == nil {
		return g.addr
	}
	return g.server.Addr
}
