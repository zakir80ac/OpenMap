// REQ-DISC-028 REQ-SEC-004 — mTLS client to the scheduler: enrol, heartbeat, pull jobs, post results.
// Pull model only: the Node opens every connection, so sites need no inbound ports.
package transport

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"time"

	"github.com/openmap/openmap/apps/node/internal/contract"
)

const (
	pathEnrol      = "/v1/nodes/enrol"
	pathHeartbeat  = "/v1/nodes/%s/heartbeat"
	pathPull       = "/v1/nodes/%s/jobs/pull"
	pathResult     = "/v1/jobs/%s/result"
	pathCreds      = "/v1/nodes/%s/credentials/resolve"
	requestTimeout = 30 * time.Second
	maxBodyBytes   = 64 << 20 // results for 10k-device sweeps stay far below this
)

type Client struct {
	base   *url.URL
	nodeID string
	http   *http.Client
}

// NewMTLS builds a client that presents the Node certificate and trusts only the OpenMap CA.
func NewMTLS(baseURL, nodeID, caPath, certPath, keyPath string) (*Client, error) {
	base, err := url.Parse(baseURL)
	if err != nil {
		return nil, fmt.Errorf("scheduler url: %w", err)
	}
	caPEM, err := os.ReadFile(caPath)
	if err != nil {
		return nil, fmt.Errorf("read CA: %w", err)
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(caPEM) {
		return nil, errors.New("CA file contains no certificates")
	}
	cert, err := tls.LoadX509KeyPair(certPath, keyPath)
	if err != nil {
		return nil, fmt.Errorf("load node certificate: %w", err)
	}
	tlsCfg := &tls.Config{RootCAs: pool, Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS13}
	return &Client{base: base, nodeID: nodeID, http: &http.Client{Timeout: requestTimeout, Transport: &http.Transport{TLSClientConfig: tlsCfg}}}, nil
}

// NewEnrolment builds a one-shot client that trusts the CA but has no client certificate yet.
func NewEnrolment(baseURL, nodeID, caPath string) (*Client, error) {
	base, err := url.Parse(baseURL)
	if err != nil {
		return nil, fmt.Errorf("scheduler url: %w", err)
	}
	pool := x509.NewCertPool()
	if caPEM, err := os.ReadFile(caPath); err == nil {
		pool.AppendCertsFromPEM(caPEM)
	}
	return &Client{base: base, nodeID: nodeID, http: &http.Client{Timeout: requestTimeout, Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS13}}}}, nil
}

// NewWithHTTPClient is for tests and for plain-HTTP development against a local scheduler.
func NewWithHTTPClient(baseURL, nodeID string, hc *http.Client) (*Client, error) {
	base, err := url.Parse(baseURL)
	if err != nil {
		return nil, err
	}
	return &Client{base: base, nodeID: nodeID, http: hc}, nil
}

type EnrolRequest struct {
	NodeID   string `json:"nodeId"`
	SiteCode string `json:"siteCode"`
	Token    string `json:"token"`
	CSRPEM   string `json:"csrPem"`
}

type EnrolResponse struct {
	CertificatePEM string    `json:"certificatePem"`
	CAPEM          string    `json:"caPem"`
	ExpiresAt      time.Time `json:"expiresAt"`
}

type Heartbeat struct {
	NodeID        string    `json:"nodeId"`
	SiteCode      string    `json:"siteCode"`
	Version       string    `json:"version"`
	ActiveJobs    int       `json:"activeJobs"`
	MaxJobs       int       `json:"maxConcurrency"`
	Collectors    []string  `json:"collectors"`
	CertExpiresAt time.Time `json:"certificateExpiresAt"`
	SentAt        time.Time `json:"sentAt"`
}

type PullRequest struct {
	Capacity   int      `json:"capacity"`
	Collectors []string `json:"collectors"`
}

type PullResponse struct {
	Jobs []contract.Job `json:"jobs"`
}

type CredentialRequest struct {
	CredentialRef string `json:"credentialRef"`
	JobID         string `json:"jobId"`
}

func (c *Client) do(ctx context.Context, method, path string, in, out any) error {
	var body io.Reader
	if in != nil {
		buf, err := json.Marshal(in)
		if err != nil {
			return err
		}
		body = bytes.NewReader(buf)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.base.ResolveReference(&url.URL{Path: path}).String(), body)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("X-OpenMap-Node", c.nodeID)
	req.Header.Set("X-OpenMap-Contract", contract.Version)
	res, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, maxBodyBytes))
	if err != nil {
		return err
	}
	if res.StatusCode < http.StatusOK || res.StatusCode >= http.StatusMultipleChoices {
		return &HTTPError{Status: res.StatusCode, Body: string(data)}
	}
	if out != nil && len(data) > 0 {
		return json.Unmarshal(data, out)
	}
	return nil
}

type HTTPError struct {
	Status int
	Body   string
}

func (e *HTTPError) Error() string {
	return fmt.Sprintf("scheduler responded %d: %s", e.Status, e.Body)
}

// Retryable reports whether the scheduler's answer warrants a retry on the next tick.
func (e *HTTPError) Retryable() bool {
	return e.Status == http.StatusTooManyRequests || e.Status >= http.StatusInternalServerError
}

func (c *Client) Enrol(ctx context.Context, req EnrolRequest) (EnrolResponse, error) {
	var out EnrolResponse
	err := c.do(ctx, http.MethodPost, pathEnrol, req, &out)
	return out, err
}

func (c *Client) Heartbeat(ctx context.Context, hb Heartbeat) error {
	return c.do(ctx, http.MethodPost, fmt.Sprintf(pathHeartbeat, c.nodeID), hb, nil)
}

func (c *Client) Pull(ctx context.Context, req PullRequest) ([]contract.Job, error) {
	var out PullResponse
	if err := c.do(ctx, http.MethodPost, fmt.Sprintf(pathPull, c.nodeID), req, &out); err != nil {
		return nil, err
	}
	return out.Jobs, nil
}

func (c *Client) PostResult(ctx context.Context, result contract.Result) error {
	return c.do(ctx, http.MethodPost, fmt.Sprintf(pathResult, result.JobID), result, nil)
}

// ResolveCredential asks the scheduler, which holds the OpenBao token, to resolve a reference for a job.
// The Node holds the clear credential only in memory for the collector's lifetime.
func (c *Client) ResolveCredential(ctx context.Context, ref, jobID string) (contract.Credential, error) {
	var out contract.Credential
	err := c.do(ctx, http.MethodPost, fmt.Sprintf(pathCreds, c.nodeID), CredentialRequest{CredentialRef: ref, JobID: jobID}, &out)
	return out, err
}
