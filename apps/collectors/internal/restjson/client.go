// REQ-DISC-001 — shared HTTPS JSON client for API-driven collectors (Kubernetes, Nutanix Prism,
// cloud and SaaS families): bearer or basic auth, optional CA pinning, status-code classification
// into contract error codes, and raw-body capture for evidence.
package restjson

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"sync"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/collector"
	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

const defaultTimeout = 60 * time.Second

// Auth describes how requests are authenticated. Exactly one of Bearer or User is used.
type Auth struct {
	Bearer string
	User   string
	Pass   string
}

// Options configure TLS verification and an optional private CA bundle (PEM).
type Options struct {
	VerifyTLS bool
	CAPem     string
	Timeout   time.Duration
	Headers   map[string]string
}

type Client struct {
	Base    *url.URL
	http    *http.Client
	auth    Auth
	headers map[string]string
	mu      sync.Mutex
	raw     [][]byte
}

// New builds a client for a base URL. `base` may be "host", "host:port" or a full https URL.
func New(base string, defaultPort int, auth Auth, opts Options) (*Client, error) {
	u, err := parseBase(base, defaultPort)
	if err != nil {
		return nil, err
	}
	tlsCfg := &tls.Config{InsecureSkipVerify: !opts.VerifyTLS, MinVersion: tls.VersionTLS12} //nolint:gosec // private-CA appliances; verifyTls=true or caCertPem enforce the chain.
	if opts.CAPem != "" {
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM([]byte(opts.CAPem)) {
			return nil, collector.Errorf(contract.ErrInternal, false, "caCertPem option holds no PEM certificate")
		}
		tlsCfg.RootCAs = pool
		tlsCfg.InsecureSkipVerify = false
	}
	timeout := opts.Timeout
	if timeout == 0 {
		timeout = defaultTimeout
	}
	return &Client{Base: u, http: &http.Client{Timeout: timeout, Transport: &http.Transport{TLSClientConfig: tlsCfg}}, auth: auth, headers: opts.Headers}, nil
}

func parseBase(base string, defaultPort int) (*url.URL, error) {
	if len(base) > len("https://") && (base[:len("https://")] == "https://" || base[:len("http://")] == "http://") {
		return url.Parse(base)
	}
	host, port, err := net.SplitHostPort(base)
	if err != nil {
		host, port = base, strconv.Itoa(defaultPort)
	}
	return &url.URL{Scheme: "https", Host: net.JoinHostPort(host, port)}, nil
}

// Transport builds an HTTPS transport with the collector TLS policy for callers that need raw
// http access (login endpoints returning tokens in headers).
func Transport(verifyTLS bool) *http.Transport {
	return &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: !verifyTLS, MinVersion: tls.VersionTLS12}} //nolint:gosec // see New
}

// Raw returns every successful response body captured so far.
func (c *Client) Raw() [][]byte {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([][]byte, len(c.raw))
	copy(out, c.raw)
	return out
}

// Do performs a request and decodes JSON into out. HTTP errors become contract errors.
func (c *Client) Do(ctx context.Context, method, path string, body any, out any) (int, error) {
	rel, err := url.Parse(path)
	if err != nil {
		return 0, err
	}
	u := c.Base.ResolveReference(rel)
	var rdr io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return 0, err
		}
		rdr = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, u.String(), rdr)
	if err != nil {
		return 0, err
	}
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if c.auth.Bearer != "" {
		req.Header.Set("Authorization", "Bearer "+c.auth.Bearer)
	} else if c.auth.User != "" {
		req.SetBasicAuth(c.auth.User, c.auth.Pass)
	}
	for k, v := range c.headers {
		req.Header.Set(k, v)
	}
	res, err := c.http.Do(req)
	if err != nil {
		return 0, Classify(u.Host, err)
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(res.Body)
	if err != nil {
		return res.StatusCode, Classify(u.Host, err)
	}
	switch {
	case res.StatusCode == http.StatusUnauthorized:
		return res.StatusCode, collector.Errorf(contract.ErrAuthFailed, false, "%s rejected the credential (%d) at %s", u.Host, res.StatusCode, path)
	case res.StatusCode == http.StatusForbidden:
		return res.StatusCode, collector.Errorf(contract.ErrPermissionDenied, false, "%s denied %s (%d)", u.Host, path, res.StatusCode)
	case res.StatusCode == http.StatusTooManyRequests:
		return res.StatusCode, collector.Errorf(contract.ErrRateLimited, true, "%s rate limited %s", u.Host, path)
	case res.StatusCode == http.StatusNotFound:
		return res.StatusCode, collector.Errorf(contract.ErrUnsupportedDevice, false, "%s has no %s", u.Host, path)
	case res.StatusCode >= http.StatusInternalServerError:
		return res.StatusCode, collector.Errorf(contract.ErrUnreachable, true, "%s returned %d for %s", u.Host, res.StatusCode, path)
	case res.StatusCode >= http.StatusBadRequest:
		return res.StatusCode, collector.Errorf(contract.ErrUnsupportedDevice, false, "%s returned %d for %s", u.Host, res.StatusCode, path)
	}
	c.mu.Lock()
	c.raw = append(c.raw, raw)
	c.mu.Unlock()
	if out != nil && len(raw) > 0 {
		if err := json.Unmarshal(raw, out); err != nil {
			return res.StatusCode, collector.Errorf(contract.ErrParse, false, "%s: invalid JSON at %s: %v", u.Host, path, err)
		}
	}
	return res.StatusCode, nil
}

// Get is Do with GET and no body.
func (c *Client) Get(ctx context.Context, path string, out any) error {
	_, err := c.Do(ctx, http.MethodGet, path, nil, out)
	return err
}

// Post is Do with POST and a JSON body.
func (c *Client) Post(ctx context.Context, path string, body any, out any) error {
	_, err := c.Do(ctx, http.MethodPost, path, body, out)
	return err
}

// Classify turns transport errors into contract errors; contract errors pass through unchanged.
func Classify(host string, err error) error {
	var te *collector.TargetError
	if errors.As(err, &te) {
		return err
	}
	var ne net.Error
	if errors.As(err, &ne) && ne.Timeout() {
		return collector.Errorf(contract.ErrTimeout, true, "%s timed out", host)
	}
	return collector.Errorf(contract.ErrUnreachable, true, "%s: %v", host, err)
}

// IsNotFound reports whether err is the unsupported_device error raised for a 404.
// IsForbidden reports the permission_denied error raised for a 403: the credential lacks a right an optional call needs.
func IsForbidden(err error) bool {
	var te *collector.TargetError
	return errors.As(err, &te) && te.Code == contract.ErrPermissionDenied
}

func IsNotFound(err error) bool {
	var te *collector.TargetError
	return errors.As(err, &te) && te.Code == contract.ErrUnsupportedDevice
}

// BoolOption reads a boolean job option.
func BoolOption(options map[string]any, key string) bool {
	v, _ := options[key].(bool)
	return v
}

// StringOption reads a string job option.
func StringOption(options map[string]any, key string) string {
	v, _ := options[key].(string)
	return v
}

// IntOption reads a positive integer job option or returns the fallback.
func IntOption(options map[string]any, key string, fallback int) int {
	switch v := options[key].(type) {
	case int:
		if v > 0 {
			return v
		}
	case float64:
		if v > 0 {
			return int(v)
		}
	case string:
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return fallback
}
