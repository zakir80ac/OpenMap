// T-077 REQ-DISC-031 — the Node's environment file parser and its precedence rule.
package envfile

import (
	"os"
	"path/filepath"
	"testing"
)

func TestParseAndLoad(t *testing.T) {
	got := Parse("# node\nOPENMAP_NODE_ID=node-ryd-01\nexport OPENMAP_SITE_CODE=\"RYD\"\nbroken\n")
	if len(got) != 2 || got["OPENMAP_NODE_ID"] != "node-ryd-01" || got["OPENMAP_SITE_CODE"] != "RYD" {
		t.Fatalf("parse wrong: %+v", got)
	}
	path := filepath.Join(t.TempDir(), "node.env")
	if err := os.WriteFile(path, []byte("OPENMAP_TEST_X=file\nOPENMAP_TEST_Y=file\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("OPENMAP_TEST_X", "env")
	if err := Load(path); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Unsetenv("OPENMAP_TEST_Y") })
	if os.Getenv("OPENMAP_TEST_X") != "env" || os.Getenv("OPENMAP_TEST_Y") != "file" {
		t.Fatal("environment must win over the file; file fills the gaps")
	}
	if err := Load(filepath.Join(t.TempDir(), "absent.env")); err != nil {
		t.Fatalf("missing file must be fine: %v", err)
	}
}
