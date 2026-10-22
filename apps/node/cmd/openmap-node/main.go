// REQ-DISC-028 REQ-DISC-031 — Discovery Node entry point: `openmap-node enrol` obtains the mTLS
// certificate with a one-time token; `openmap-node run` starts the pull loop. Structured logging via slog.
package main

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/openmap/openmap/apps/node/internal/config"
	noderuntime "github.com/openmap/openmap/apps/node/internal/runtime"
	"github.com/openmap/openmap/apps/node/internal/supervisor"
	"github.com/openmap/openmap/apps/node/internal/transport"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: openmap-node <enrol|run|version>")
		os.Exit(2)
	}
	cfg, err := config.Load()
	if err != nil && os.Args[1] != "version" {
		fmt.Fprintln(os.Stderr, "configuration:", err)
		os.Exit(2)
	}
	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: level(cfg.LogLevel)}))
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	switch os.Args[1] {
	case "version":
		fmt.Println(noderuntime.Version)
	case "enrol":
		if err := enrol(ctx, cfg, log); err != nil {
			log.Error("enrolment failed", "err", err)
			os.Exit(1)
		}
	case "run":
		if err := run(ctx, cfg, log); err != nil {
			log.Error("node stopped with error", "err", err)
			os.Exit(1)
		}
	default:
		fmt.Fprintln(os.Stderr, "unknown command", os.Args[1])
		os.Exit(2)
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

// enrol generates a P-256 key, submits a CSR with the one-time token and stores the issued certificate.
func enrol(ctx context.Context, cfg config.Config, log *slog.Logger) error {
	if cfg.EnrolToken == "" {
		return errors.New("OPENMAP_ENROL_TOKEN is required for enrolment")
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return err
	}
	csrDER, err := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{Subject: pkix.Name{CommonName: cfg.NodeID, OrganizationalUnit: []string{cfg.SiteCode}}}, key)
	if err != nil {
		return err
	}
	client, err := transport.NewEnrolment(cfg.SchedulerURL, cfg.NodeID, cfg.MTLSCAPath)
	if err != nil {
		return err
	}
	res, err := client.Enrol(ctx, transport.EnrolRequest{NodeID: cfg.NodeID, SiteCode: cfg.SiteCode, Token: cfg.EnrolToken, CSRPEM: string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE REQUEST", Bytes: csrDER}))})
	if err != nil {
		return err
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return err
	}
	for _, p := range []string{cfg.MTLSCertPath, cfg.MTLSKeyPath, cfg.MTLSCAPath} {
		if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
			return err
		}
	}
	if err := os.WriteFile(cfg.MTLSKeyPath, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER}), 0o600); err != nil {
		return err
	}
	if err := os.WriteFile(cfg.MTLSCertPath, []byte(res.CertificatePEM), 0o600); err != nil {
		return err
	}
	if res.CAPEM != "" {
		if err := os.WriteFile(cfg.MTLSCAPath, []byte(res.CAPEM), 0o644); err != nil {
			return err
		}
	}
	log.Info("enrolled", "node", cfg.NodeID, "site", cfg.SiteCode, "certificateExpiresAt", res.ExpiresAt)
	return nil
}

func run(ctx context.Context, cfg config.Config, log *slog.Logger) error {
	client, err := transport.NewMTLS(cfg.SchedulerURL, cfg.NodeID, cfg.MTLSCAPath, cfg.MTLSCertPath, cfg.MTLSKeyPath)
	if err != nil {
		return fmt.Errorf("mTLS setup (run `openmap-node enrol` first): %w", err)
	}
	expires, err := certificateExpiry(cfg.MTLSCertPath)
	if err != nil {
		return err
	}
	sup := supervisor.New(cfg.CollectorsDir, cfg.EvidenceDir, log)
	node := noderuntime.New(noderuntime.Options{NodeID: cfg.NodeID, SiteCode: cfg.SiteCode, MaxConcurrentJobs: cfg.MaxConcurrentJobs, PullInterval: cfg.JobPullInterval, HeartbeatInterval: cfg.HeartbeatInterval, CertExpiresAt: expires}, client, sup, log)
	return node.Run(ctx)
}

func certificateExpiry(path string) (time.Time, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return time.Time{}, err
	}
	block, _ := pem.Decode(data)
	if block == nil {
		return time.Time{}, errors.New("node certificate is not PEM")
	}
	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return time.Time{}, err
	}
	return cert.NotAfter, nil
}
