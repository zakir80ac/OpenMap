// T-076 REQ-DISC-004 — the environment file parser accepts systemd's EnvironmentFile format and never overrides a
// variable the service manager already set.
package agent

import (
	"os"
	"path/filepath"
	"testing"
)

func TestParseEnvFile(t *testing.T) {
	got := ParseEnvFile("# agent settings\nOPENMAP_AGENT_NODE_URL=https://node-ryd-01:4300\nexport OPENMAP_AGENT_ID=\"app-ryd-07.bank.local\"\nLOG_LEVEL='debug'\nbad line\n=novalue\n")
	if len(got) != 3 || got["OPENMAP_AGENT_NODE_URL"] != "https://node-ryd-01:4300" || got["OPENMAP_AGENT_ID"] != "app-ryd-07.bank.local" || got["LOG_LEVEL"] != "debug" {
		t.Fatalf("parse wrong: %+v", got)
	}
}

func TestLoadEnvFileDoesNotOverride(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent.env")
	if err := os.WriteFile(path, []byte("OPENMAP_TEST_A=from-file\nOPENMAP_TEST_B=from-file\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("OPENMAP_TEST_A", "from-environment")
	if err := LoadEnvFile(path); err != nil {
		t.Fatal(err)
	}
	if os.Getenv("OPENMAP_TEST_A") != "from-environment" || os.Getenv("OPENMAP_TEST_B") != "from-file" {
		t.Fatalf("precedence wrong: %q %q", os.Getenv("OPENMAP_TEST_A"), os.Getenv("OPENMAP_TEST_B"))
	}
	t.Cleanup(func() { _ = os.Unsetenv("OPENMAP_TEST_B") })
	if err := LoadEnvFile(filepath.Join(t.TempDir(), "missing.env")); err != nil {
		t.Fatalf("a missing file must not fail: %v", err)
	}
}
