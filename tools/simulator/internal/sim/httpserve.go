// REQ-QA-005 — HTTP(S) plumbing shared by the REST and SOAP simulators: loopback listeners, credential checks
// that answer 401/403 like the real product, JSON/XML writers and a request log for diagnosing a failed run.
package sim

import (
	"context"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"encoding/xml"
	"errors"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

const readHeaderTimeout = 10 * time.Second

// RequestLog records method, path and status of every request a simulator answered.
type RequestLog struct {
	mu      sync.Mutex
	Entries []string
}

func (l *RequestLog) add(s string) {
	l.mu.Lock()
	l.Entries = append(l.Entries, s)
	l.mu.Unlock()
}

func (l *RequestLog) Snapshot() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]string(nil), l.Entries...)
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (s *statusRecorder) WriteHeader(code int) {
	s.status = code
	s.ResponseWriter.WriteHeader(code)
}

func (s *statusRecorder) Flush() {
	if f, ok := s.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// Listen opens a TCP listener on an ephemeral port at the bind address (loopback unless Configure changed it).
func Listen() (net.Listener, int, error) {
	ln, err := net.Listen("tcp", net.JoinHostPort(bindHost, "0"))
	if err != nil {
		return nil, 0, err
	}
	return ln, ln.Addr().(*net.TCPAddr).Port, nil
}

// ListenUDP opens a UDP socket on an ephemeral port at the bind address.
func ListenUDP() (*net.UDPConn, int, error) {
	addr, err := net.ResolveUDPAddr("udp", net.JoinHostPort(bindHost, "0"))
	if err != nil {
		return nil, 0, err
	}
	conn, err := net.ListenUDP("udp", addr)
	if err != nil {
		return nil, 0, err
	}
	return conn, conn.LocalAddr().(*net.UDPAddr).Port, nil
}

// Address is host:port as collectors dial it (the advertised host).
func Address(port int) string { return net.JoinHostPort(advertiseHost, strconv.Itoa(port)) }

// ServeHTTPS serves h over TLS (the simulated-mode CA) on loopback.
func ServeHTTPS(env *Env, h http.Handler) (*Endpoint, *RequestLog, error) {
	return serve(env, h, true)
}

// ServeHTTP serves h in clear text on loopback, for products whose API is plain HTTP by default.
func ServeHTTP(env *Env, h http.Handler) (*Endpoint, *RequestLog, error) {
	return serve(env, h, false)
}

func serve(env *Env, h http.Handler, secure bool) (*Endpoint, *RequestLog, error) {
	log := &RequestLog{}
	ep, err := serveWith(env, h, secure, log)
	if err != nil {
		return nil, nil, err
	}
	ep.State["log"] = log
	return ep, log, nil
}

// ServeEach starts one HTTPS (secure) or HTTP listener per device key, for products where one collector
// target is one appliance. Endpoint.Devices maps each key to its base URL; all share one request log.
func ServeEach(env *Env, keys []string, secure bool, handler func(key string) http.Handler) (*Endpoint, error) {
	log := &RequestLog{}
	group := &Endpoint{Host: advertiseHost, State: map[string]any{"log": log}, Devices: map[string]string{}}
	for _, k := range keys {
		ep, err := serveWith(env, handler(k), secure, log)
		if err != nil {
			_ = group.Close()
			return nil, err
		}
		group.Devices[k] = ep.URL
		group.OnClose(ep.Close)
	}
	return group, nil
}

func serveWith(env *Env, h http.Handler, secure bool, log *RequestLog) (*Endpoint, error) {
	ln, port, err := Listen()
	if err != nil {
		return nil, err
	}
	wrapped := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		h.ServeHTTP(rec, r)
		log.add(r.Method + " " + r.URL.RequestURI() + " " + strconv.Itoa(rec.status))
	})
	srv := &http.Server{Handler: wrapped, ReadHeaderTimeout: readHeaderTimeout}
	scheme := "http"
	if secure {
		scheme = "https"
		ln = tls.NewListener(ln, env.CA.ServerConfig())
	}
	go func() { _ = srv.Serve(ln) }()
	ep := &Endpoint{Host: advertiseHost, Port: port, URL: scheme + "://" + Address(port), State: map[string]any{}}
	ep.OnClose(func() error {
		ctx, cancel := context.WithTimeout(context.Background(), readHeaderTimeout)
		defer cancel()
		if err := srv.Shutdown(ctx); err != nil && !errors.Is(err, http.ErrServerClosed) {
			return err
		}
		return nil
	})
	return ep, nil
}

// BasicOK reports whether the request carries the simulated user and secret as HTTP Basic credentials.
func (env *Env) BasicOK(r *http.Request) bool {
	u, p, ok := r.BasicAuth()
	return ok && u == env.User && p == env.Secret
}

// BearerOK reports whether the request carries token as a Bearer token.
func BearerOK(r *http.Request, token string) bool {
	return strings.TrimSpace(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")) == token &&
		strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ")
}

// BasicHeader is the Authorization header value for the simulated credentials.
func (env *Env) BasicHeader() string {
	return "Basic " + base64.StdEncoding.EncodeToString([]byte(env.User+":"+env.Secret))
}

// Token derives a stable opaque session token for one simulator from the process secret.
func (env *Env) Token(scope string) string { return scope + "-" + env.Secret }

func WriteJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func WriteXML(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/xml")
	w.WriteHeader(status)
	_, _ = w.Write([]byte(xml.Header))
	_ = xml.NewEncoder(w).Encode(v)
}

// WriteRaw writes a body with the given content type.
func WriteRaw(w http.ResponseWriter, status int, contentType string, body []byte) {
	w.Header().Set("Content-Type", contentType)
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

func Unauthorized(w http.ResponseWriter) {
	WriteJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized", "provenance": Provenance})
}

func NotFound(w http.ResponseWriter) {
	WriteJSON(w, http.StatusNotFound, map[string]string{"error": "not found", "provenance": Provenance})
}
