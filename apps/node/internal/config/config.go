// REQ-DISC-028 — Discovery Node configuration. Every value comes from the environment, mirroring the
// defaults documented in packages/config/src/env.ts; nothing here is a deployment-specific literal.
package config

import (
	"errors"
	"fmt"
	"os"
	"strconv"
	"time"
)

type Config struct {
	NodeID       string
	SiteCode     string
	SchedulerURL string
	MTLSCAPath   string
	MTLSCertPath string
	MTLSKeyPath  string
	EnrolToken   string
	// BootstrapCAPath trusts the scheduler during enrolment when MTLSCAPath does not exist yet
	// (the enrolment response then writes the CA to MTLSCAPath). Optional; operators who
	// distribute the CA file directly leave it empty.
	BootstrapCAPath   string
	JobPullInterval   time.Duration
	HeartbeatInterval time.Duration
	CollectorsDir     string
	EvidenceDir       string
	MaxConcurrentJobs int
	LogLevel          string
	MetricsAddr       string
	// AgentListenAddr enables the agent gateway (REQ-DISC-004) when set, e.g. ":4300"; empty keeps it off.
	AgentListenAddr string
}

const (
	envNodeID            = "OPENMAP_NODE_ID"
	envSiteCode          = "OPENMAP_SITE_CODE"
	envSchedulerURL      = "OPENMAP_SCHEDULER_URL"
	envCAPath            = "NODE_MTLS_CA_PATH"
	envCertPath          = "NODE_MTLS_CERT_PATH"
	envKeyPath           = "NODE_MTLS_KEY_PATH"
	envEnrolToken        = "OPENMAP_ENROL_TOKEN"
	envBootstrapCA       = "OPENMAP_BOOTSTRAP_CA_PATH"
	envJobPullIntervalMs = "NODE_JOB_PULL_INTERVAL_MS"
	envHeartbeatMs       = "NODE_HEARTBEAT_INTERVAL_MS"
	envCollectorsDir     = "OPENMAP_COLLECTORS_DIR"
	envEvidenceDir       = "OPENMAP_EVIDENCE_DIR"
	envMaxJobs           = "OPENMAP_MAX_CONCURRENT_JOBS"
	envLogLevel          = "LOG_LEVEL"
	envMetricsAddr       = "OPENMAP_NODE_METRICS_ADDR"
	envAgentListenAddr   = "OPENMAP_AGENT_LISTEN_ADDR"
	envEnvFile           = "OPENMAP_NODE_ENV_FILE"

	defaultJobPullIntervalMs = 5000
	defaultHeartbeatMs       = 15000
	defaultMaxJobs           = 4
	defaultLogLevel          = "info"
	defaultMetricsAddr       = ":9400"
	defaultCollectorsDir     = "/opt/openmap/collectors"
	defaultEvidenceDir       = "/var/lib/openmap/evidence"
	defaultCAPath            = "/etc/openmap/pki/ca.crt"
	defaultCertPath          = "/etc/openmap/pki/node.crt"
	defaultKeyPath           = "/etc/openmap/pki/node.key"
	defaultEnvFile           = "/etc/openmap/node.env"
)

// EnvFilePath is where the installer writes the Node's settings for the service manager (OPENMAP_NODE_ENV_FILE).
func EnvFilePath() string {
	return env(envEnvFile, defaultEnvFile)
}

func env(key, fallback string) string {
	if v, ok := os.LookupEnv(key); ok && v != "" {
		return v
	}
	return fallback
}

func envInt(key string, fallback int) (int, error) {
	v, ok := os.LookupEnv(key)
	if !ok || v == "" {
		return fallback, nil
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return 0, fmt.Errorf("%s must be an integer: %w", key, err)
	}
	return n, nil
}

// Load reads and validates the environment. Missing required values are reported together.
func Load() (Config, error) {
	var problems []error
	cfg := Config{
		NodeID:          env(envNodeID, ""),
		SiteCode:        env(envSiteCode, ""),
		SchedulerURL:    env(envSchedulerURL, ""),
		MTLSCAPath:      env(envCAPath, defaultCAPath),
		MTLSCertPath:    env(envCertPath, defaultCertPath),
		MTLSKeyPath:     env(envKeyPath, defaultKeyPath),
		EnrolToken:      env(envEnrolToken, ""),
		BootstrapCAPath: env(envBootstrapCA, ""),
		CollectorsDir:   env(envCollectorsDir, defaultCollectorsDir),
		EvidenceDir:     env(envEvidenceDir, defaultEvidenceDir),
		LogLevel:        env(envLogLevel, defaultLogLevel),
		MetricsAddr:     env(envMetricsAddr, defaultMetricsAddr),
		AgentListenAddr: env(envAgentListenAddr, ""),
	}
	if cfg.NodeID == "" {
		problems = append(problems, errors.New(envNodeID+" is required"))
	}
	if cfg.SiteCode == "" {
		problems = append(problems, errors.New(envSiteCode+" is required"))
	}
	if cfg.SchedulerURL == "" {
		problems = append(problems, errors.New(envSchedulerURL+" is required"))
	}
	pull, err := envInt(envJobPullIntervalMs, defaultJobPullIntervalMs)
	if err != nil {
		problems = append(problems, err)
	}
	hb, err := envInt(envHeartbeatMs, defaultHeartbeatMs)
	if err != nil {
		problems = append(problems, err)
	}
	maxJobs, err := envInt(envMaxJobs, defaultMaxJobs)
	if err != nil {
		problems = append(problems, err)
	}
	if maxJobs < 1 {
		problems = append(problems, errors.New(envMaxJobs+" must be at least 1"))
	}
	cfg.JobPullInterval = time.Duration(pull) * time.Millisecond
	cfg.HeartbeatInterval = time.Duration(hb) * time.Millisecond
	cfg.MaxConcurrentJobs = maxJobs
	if len(problems) > 0 {
		return Config{}, errors.Join(problems...)
	}
	return cfg, nil
}
