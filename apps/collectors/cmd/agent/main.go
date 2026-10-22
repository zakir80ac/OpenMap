// REQ-DISC-004 — openmap-agent: the host agent binary (Windows, Linux, macOS). `collect` prints the host's
// inventory as a collector observation; `enrol` exchanges a one-time token for an mTLS certificate through the
// site's Discovery Node; `report` sends one inventory; `run` reports on an interval. Every setting comes from the
// environment (mirroring the Node's conventions); nothing deployment-specific lives in the binary.
package main

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"syscall"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/agent"
	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

const (
	envNodeURL    = "OPENMAP_AGENT_NODE_URL"
	envAgentID    = "OPENMAP_AGENT_ID"
	envEnrolToken = "OPENMAP_ENROL_TOKEN"
	envCAPath     = "AGENT_MTLS_CA_PATH"
	envCertPath   = "AGENT_MTLS_CERT_PATH"
	envKeyPath    = "AGENT_MTLS_KEY_PATH"
	envBootstrap  = "OPENMAP_BOOTSTRAP_CA_PATH"
	envIntervalMs = "OPENMAP_AGENT_INTERVAL_MS"
	envLogLevel   = "LOG_LEVEL"

	defaultIntervalMs = 900_000
	httpTimeout       = 120 * time.Second
	pathEnrol         = "/v1/agents/enrol"
	pathReport        = "/v1/agents/report"
	evidenceKind      = "agent_report"
	dirMode           = 0o700
	fileMode          = 0o600
	caMode            = 0o644
)

// defaultPKIDir is the platform's conventional configuration root; operators override every path by environment.
func defaultPKIDir() string {
	if base := os.Getenv("ProgramData"); base != "" {
		return filepath.Join(base, "OpenMap", "agent")
	}
	return filepath.Join(string(filepath.Separator), "etc", "openmap", "agent")
}

type config struct {
	NodeURL     string
	AgentID     string
	EnrolToken  string
	CAPath      string
	CertPath    string
	KeyPath     string
	BootstrapCA string
	Interval    time.Duration
	LogLevel    string
}

func env(key, fallback string) string {
	if v, ok := os.LookupEnv(key); ok && v != "" {
		return v
	}
	return fallback
}

func loadConfig() (config, error) {
	host, _ := os.Hostname()
	dir := defaultPKIDir()
	intervalMs, err := strconv.Atoi(env(envIntervalMs, strconv.Itoa(defaultIntervalMs)))
	if err != nil || intervalMs <= 0 {
		return config{}, fmt.Errorf("%s must be a positive integer of milliseconds", envIntervalMs)
	}
	return config{
		NodeURL:     env(envNodeURL, ""),
		AgentID:     env(envAgentID, host),
		EnrolToken:  env(envEnrolToken, ""),
		CAPath:      env(envCAPath, filepath.Join(dir, "ca.crt")),
		CertPath:    env(envCertPath, filepath.Join(dir, "agent.crt")),
		KeyPath:     env(envKeyPath, filepath.Join(dir, "agent.key")),
		BootstrapCA: env(envBootstrap, ""),
		Interval:    time.Duration(intervalMs) * time.Millisecond,
		LogLevel:    env(envLogLevel, "info"),
	}, nil
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: openmap-agent <collect|enrol|report|run|version>")
		os.Exit(2)
	}
	cfg, err := loadConfig()
	if err != nil {
		fmt.Fprintln(os.Stderr, "configuration:", err)
		os.Exit(2)
	}
	log := slog.New(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: level(cfg.LogLevel)}))
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	var runErr error
	switch os.Args[1] {
	case "--manifest", "manifest":
		// The agent is listed beside the collector families (docs/COLLECTORS.md is generated from this).
		enc := json.NewEncoder(os.Stdout)
		runErr = enc.Encode(contract.Manifest{ID: "agent", Family: "agent", Version: agent.Version, Language: "go", Protocols: []string{"mtls"}, CredentialTypes: []string{"none"}, TargetKinds: []string{"host"}, Emits: []string{"host", "operating_system", "ip_address", "listening_service", "software", "software_instance"}, ContractVersion: contract.Version})
	case "version":
		fmt.Println(agent.Version)
	case "collect":
		runErr = collect(ctx)
	case "enrol":
		runErr = enrol(ctx, cfg, log)
	case "report":
		runErr = report(ctx, cfg, log)
	case "run":
		runErr = run(ctx, cfg, log)
	default:
		fmt.Fprintln(os.Stderr, "unknown command", os.Args[1])
		os.Exit(2)
	}
	if runErr != nil {
		log.Error("agent failed", "command", os.Args[1], "err", runErr)
		os.Exit(1)
	}
}

func level(name string) slog.Level {
	switch name {
	case "debug", "trace":
		return slog.LevelDebug
	case "warn":
		return slog.LevelWarn
	case "error", "fatal":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}

// collect prints the observation to stdout, the same JSON every collector binary emits.
func collect(ctx context.Context) error {
	inv, err := agent.Collect(ctx)
	if err != nil {
		return err
	}
	obs := agent.Emit(inv)
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	return enc.Encode(map[string]any{"agentId": inv.FQDN, "agentVersion": agent.Version, "collectedAt": inv.CollectedAt, "cis": obs.Cis, "relationships": obs.Relationships})
}

func requireNode(cfg config) error {
	if cfg.NodeURL == "" {
		return fmt.Errorf("%s is required: the HTTPS address of the Discovery Node's agent gateway", envNodeURL)
	}
	return nil
}

func trustPool(path string) (*x509.CertPool, error) {
	pool := x509.NewCertPool()
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	if !pool.AppendCertsFromPEM(data) {
		return nil, errors.New("CA file holds no certificate: " + path)
	}
	return pool, nil
}

// enrol generates a P-256 key and CSR, presents the one-time token to the Node, and stores the issued certificate.
func enrol(ctx context.Context, cfg config, log *slog.Logger) error {
	if err := requireNode(cfg); err != nil {
		return err
	}
	if cfg.EnrolToken == "" {
		return fmt.Errorf("%s is required for enrolment", envEnrolToken)
	}
	trust := cfg.CAPath
	if _, err := os.Stat(trust); err != nil && cfg.BootstrapCA != "" {
		trust = cfg.BootstrapCA
	}
	pool, err := trustPool(trust)
	if err != nil {
		return fmt.Errorf("trusting the Node needs the discovery CA (%s or %s): %w", envCAPath, envBootstrap, err)
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return err
	}
	csrDER, err := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{Subject: pkix.Name{CommonName: cfg.AgentID}}, key)
	if err != nil {
		return err
	}
	body, _ := json.Marshal(map[string]string{"agentId": cfg.AgentID, "token": cfg.EnrolToken, "csrPem": string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE REQUEST", Bytes: csrDER}))})
	client := &http.Client{Timeout: httpTimeout, Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}}}
	res, err := post(ctx, client, cfg.NodeURL+pathEnrol, body)
	if err != nil {
		return err
	}
	var issued struct {
		CertificatePEM string `json:"certificatePem"`
		CAPEM          string `json:"caPem"`
		ExpiresAt      string `json:"expiresAt"`
	}
	if err := json.Unmarshal(res, &issued); err != nil || issued.CertificatePEM == "" {
		return errors.New("enrolment response carried no certificate")
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return err
	}
	for _, p := range []string{cfg.CertPath, cfg.KeyPath, cfg.CAPath} {
		if err := os.MkdirAll(filepath.Dir(p), dirMode); err != nil {
			return err
		}
	}
	if err := os.WriteFile(cfg.KeyPath, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER}), fileMode); err != nil {
		return err
	}
	if err := os.WriteFile(cfg.CertPath, []byte(issued.CertificatePEM), fileMode); err != nil {
		return err
	}
	if issued.CAPEM != "" {
		if err := os.WriteFile(cfg.CAPath, []byte(issued.CAPEM), caMode); err != nil {
			return err
		}
	}
	log.Info("enrolled", "agent", cfg.AgentID, "node", cfg.NodeURL, "certificateExpiresAt", issued.ExpiresAt)
	return nil
}

func mtlsClient(cfg config) (*http.Client, error) {
	pool, err := trustPool(cfg.CAPath)
	if err != nil {
		return nil, fmt.Errorf("mTLS setup (run `openmap-agent enrol` first): %w", err)
	}
	cert, err := tls.LoadX509KeyPair(cfg.CertPath, cfg.KeyPath)
	if err != nil {
		return nil, fmt.Errorf("mTLS setup (run `openmap-agent enrol` first): %w", err)
	}
	return &http.Client{Timeout: httpTimeout, Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: pool, Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12}}}, nil
}

func post(ctx context.Context, client *http.Client, u string, body []byte) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("X-OpenMap-Contract", contract.Version)
	res, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	data, err := io.ReadAll(res.Body)
	if err != nil {
		return nil, err
	}
	if res.StatusCode < http.StatusOK || res.StatusCode >= http.StatusMultipleChoices {
		return nil, fmt.Errorf("%s answered %d: %s", u, res.StatusCode, string(bytes.TrimSpace(data)))
	}
	return data, nil
}

// reportOnce collects and sends one inventory through the Node.
func reportOnce(ctx context.Context, cfg config, client *http.Client, log *slog.Logger) error {
	started := time.Now().UTC()
	inv, err := agent.Collect(ctx)
	if err != nil {
		return err
	}
	obs := agent.Emit(inv)
	finished := time.Now().UTC()
	evidence := make([]contract.Evidence, 0, len(obs.Evidence))
	raw := make([]map[string]string, 0, len(obs.Evidence))
	for _, ev := range obs.Evidence {
		sum := sha256.Sum256(ev.Data)
		digest := hex.EncodeToString(sum[:])
		evidence = append(evidence, contract.Evidence{Kind: evidenceKind, Target: contract.Target{Kind: "host", Value: cfg.AgentID}, Digest: digest, SizeBytes: len(ev.Data), CapturedAt: finished})
		raw = append(raw, map[string]string{"digest": digest, "kind": evidenceKind, "data": string(ev.Data)})
	}
	body, _ := json.Marshal(map[string]any{
		"agentId": cfg.AgentID, "agentVersion": agent.Version, "startedAt": started, "finishedAt": finished,
		"cis": obs.Cis, "relationships": obs.Relationships, "evidence": evidence, "raw": raw,
	})
	res, err := post(ctx, client, cfg.NodeURL+pathReport, body)
	if err != nil {
		return err
	}
	log.Info("reported", "agent", cfg.AgentID, "cis", len(obs.Cis), "relationships", len(obs.Relationships), "response", string(bytes.TrimSpace(res)))
	return nil
}

func report(ctx context.Context, cfg config, log *slog.Logger) error {
	if err := requireNode(cfg); err != nil {
		return err
	}
	client, err := mtlsClient(cfg)
	if err != nil {
		return err
	}
	return reportOnce(ctx, cfg, client, log)
}

// run reports immediately, then on every interval until stopped; a failed report is logged and retried next tick.
func run(ctx context.Context, cfg config, log *slog.Logger) error {
	if err := requireNode(cfg); err != nil {
		return err
	}
	client, err := mtlsClient(cfg)
	if err != nil {
		return err
	}
	ticker := time.NewTicker(cfg.Interval)
	defer ticker.Stop()
	for {
		if err := reportOnce(ctx, cfg, client, log); err != nil {
			log.Warn("report failed", "err", err)
		}
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
		}
	}
}
