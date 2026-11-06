// T-303 REQ-DISC-016 — recorded vendor fixtures (packages/testing/fixtures/vendor/nas): the Samba
// testparm + knfsd exportfs transcript the real collector read over SSH, and the rpcbind GETPORT and
// MOUNT v3 EXPORT byte streams recorded from Linux rpc.mountd and NFS-Ganesha. Transcripts run through
// ParseSamba/ParseExports/Emit; RPC replies are replayed over TCP to MountPort/Exports, which must send
// byte-identical calls to the ones recorded.
package nas

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"io"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/contract"
	"github.com/openmap/openmap/apps/collectors/internal/sshexec"
)

const fixtureRoot = "../../../../packages/testing/fixtures/vendor/nas"

type wantShare struct {
	protocol string
	path     string
	name     string // Share.Name
	state    string
	clients  []string
	options  []string // must all be present
}

type nasFixture struct {
	kind      string // "transcript" or "rpc"
	mountPort int
	shares    []wantShare
}

var nasFixtures = map[string]nasFixture{
	"samba-samba-4.17.12": {kind: "transcript", shares: []wantShare{
		{protocol: protocolSMB, path: "/srv/samba/finance", name: "finance", state: "online", clients: []string{"@finance", "svc-backup"}, options: []string{"read only=no"}},
		{protocol: protocolSMB, path: "/srv/samba/public", name: "public", state: "online", clients: []string{}, options: []string{"guest ok=yes"}},
		{protocol: protocolSMB, path: "/srv/samba/archive", name: "archive", state: "offline", clients: []string{}, options: []string{"available=no"}},
		{protocol: protocolNFS, path: "/srv/nfs/home", name: "/srv/nfs/home", state: "online", clients: []string{"lab-app01", "192.168.112.0/20"}, options: []string{"rw", "root_squash", "sync", "no_subtree_check", "sec=sys"}},
		{protocol: protocolNFS, path: "/srv/nfs/backup", name: "/srv/nfs/backup", state: "online", clients: []string{"lab-backup01"}, options: []string{"ro", "no_root_squash"}},
	}},
	"linux-nfs-utils-2.6.2": {kind: "rpc", mountPort: 20048, shares: []wantShare{
		{protocol: protocolNFS, path: "/srv/nfs/backup", name: "/srv/nfs/backup", state: "online", clients: []string{"lab-backup01"}},
		{protocol: protocolNFS, path: "/srv/nfs/home", name: "/srv/nfs/home", state: "online", clients: []string{"192.168.112.0/20"}},
	}},
	"nfs-ganesha-nfs-ganesha-4.3": {kind: "rpc", mountPort: 20048, shares: []wantShare{
		{protocol: protocolNFS, path: "/export/projects", name: "/export/projects", state: "online", clients: []string{"192.168.112.0/20", "<unknown>"}},
		{protocol: protocolNFS, path: "/export/scratch", name: "/export/scratch", state: "online", clients: []string{"*"}},
	}},
}

// replayRPC serves the recorded exchanges: each connection's call must equal one of the recorded
// requests byte for byte, and gets that request's recorded reply.
func replayRPC(t *testing.T, exchanges map[string][]byte) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				var head [4]byte
				if _, err := io.ReadFull(c, head[:]); err != nil {
					return
				}
				body := make([]byte, binary.BigEndian.Uint32(head[:])&recordLenMask)
				if _, err := io.ReadFull(c, body); err != nil {
					return
				}
				call := append(head[:], body...)
				reply, ok := exchanges[string(call)]
				if !ok {
					t.Errorf("collector sent a call that was not recorded: % x", call)
					return
				}
				_, _ = c.Write(reply)
			}(conn)
		}
	}()
	return ln.Addr().(*net.TCPAddr).Port
}

func TestREQDISC016_T303_RecordedVendorFixtures(t *testing.T) {
	entries, err := os.ReadDir(fixtureRoot)
	if err != nil {
		t.Fatalf("fixture dir: %v", err)
	}
	seen := 0
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		seen++
		dir := e.Name()
		t.Run(dir, func(t *testing.T) {
			want, ok := nasFixtures[dir]
			if !ok {
				t.Fatalf("fixture %s has no expectation row", dir)
			}
			base := filepath.Join(fixtureRoot, dir)
			var manifest struct {
				Family string `json:"family"`
				Req    string `json:"req"`
				Files  []struct {
					Name string `json:"name"`
				} `json:"files"`
			}
			mb, err := os.ReadFile(filepath.Join(base, "manifest.json"))
			if err != nil {
				t.Fatal(err)
			}
			if err := json.Unmarshal(mb, &manifest); err != nil || manifest.Family != "nas" || manifest.Req != "REQ-DISC-016" || len(manifest.Files) == 0 {
				t.Fatalf("manifest: %v %+v", err, manifest)
			}
			for _, f := range manifest.Files {
				if _, err := os.Stat(filepath.Join(base, f.Name)); err != nil {
					t.Fatalf("manifest lists %s: %v", f.Name, err)
				}
			}
			target := contract.Target{Kind: "host", Value: "lab-fs01.lab.test"}
			var shares []Share
			var raw []byte
			switch want.kind {
			case "transcript":
				raw, err = os.ReadFile(filepath.Join(base, "transcript.txt"))
				if err != nil {
					t.Fatal(err)
				}
				sections, _ := sshexec.Split(string(raw))
				shares = append(ParseSamba(sections[sectionSamba]), ParseExports(sections[sectionNfs])...)
			case "rpc":
				exchanges := map[string][]byte{}
				for _, name := range []string{"rpcbind-getport", "mount-export"} {
					req, err := os.ReadFile(filepath.Join(base, name+".request.bin"))
					if err != nil {
						t.Fatal(err)
					}
					rep, err := os.ReadFile(filepath.Join(base, name+".reply.bin"))
					if err != nil {
						t.Fatal(err)
					}
					exchanges[string(req)] = rep
				}
				port := replayRPC(t, exchanges)
				ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()
				mountPort, err := MountPort(ctx, "127.0.0.1", port)
				if err != nil || mountPort != want.mountPort {
					t.Fatalf("GETPORT: %d %v", mountPort, err)
				}
				// The recorded server registered MOUNT on mountPort; the replay serves it on the same listener.
				exports, err := Exports(ctx, "127.0.0.1", port)
				if err != nil {
					t.Fatalf("EXPORT: %v", err)
				}
				shares = FromExports(exports)
				raw, _ = json.Marshal(exports)
			}
			if len(shares) != len(want.shares) {
				t.Fatalf("shares: got %d want %d: %+v", len(shares), len(want.shares), shares)
			}
			for i, w := range want.shares {
				s := shares[i]
				if s.Protocol != w.protocol || s.Path != w.path || s.Name != w.name || s.State != w.state || !sameList(s.Clients, w.clients) {
					t.Errorf("share %d: %+v want %+v", i, s, w)
				}
				for _, o := range w.options {
					if !contains(s.Options, o) {
						t.Errorf("share %s missing option %s: %v", s.Path, o, s.Options)
					}
				}
			}
			obs := Emit(shares, target, raw, time.Date(2026, 11, 6, 21, 10, 0, 0, time.UTC))
			if len(obs.Cis) != len(want.shares) || len(obs.Relationships) != len(want.shares) || len(obs.Evidence) != 1 || !bytes.Equal(obs.Evidence[0].Data, raw) {
				t.Fatalf("observation: %d cis %d rels", len(obs.Cis), len(obs.Relationships))
			}
			for i, ci := range obs.Cis {
				w := want.shares[i]
				if ci.Type != typeShare || ci.Identity["arrayRef"] != "lab-fs01.lab.test" || ci.Identity["protocol"] != w.protocol || ci.Identity["path"] != w.path {
					t.Errorf("ci %d identity %v", i, ci.Identity)
				}
				wantName := "lab-fs01.lab.test:" + w.path
				if w.protocol == protocolSMB {
					wantName = `\\lab-fs01.lab.test\` + w.name
				}
				health := "healthy"
				if w.state == "offline" {
					health = "down"
				}
				if ci.Name != wantName || ci.Attributes["health"] != health {
					t.Errorf("ci %d name %q health %v", i, ci.Name, ci.Attributes["health"])
				}
				r := obs.Relationships[i]
				if r.Type != relContains || r.From.Type != typeHost || r.From.Identity["fqdn"] != "lab-fs01.lab.test" || r.To.Type != typeShare || r.To.Identity["path"] != w.path {
					t.Errorf("relationship %d: %+v", i, r)
				}
			}
		})
	}
	if seen == 0 {
		t.Fatal("no recorded fixtures found")
	}
}

func sameList(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
