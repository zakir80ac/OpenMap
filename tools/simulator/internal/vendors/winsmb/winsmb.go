// REQ-QA-005 REQ-DISC-016 — simulated Windows file servers behind WinRM for the nas collector (mode windows). The
// estate's Windows file servers (hosts named *-file-*) answer the collector's script with the server's DNS name and
// what `Get-SmbShare | Where-Object Special -eq $false` and Get-SmbShareAccess print through ConvertTo-Json
// (ShareState, AccessRight and AccessControlType as enum integers; one share prints an object, several an array).
//
// The estate carries no nas_share CIs, so each server's shares are a deterministic set seeded from its FQDN (share
// names from a fixed catalogue, one to five per server, session counts, encryption, one share offline on some
// servers) and the expectations come from that same set.
package winsmb

import (
	"context"
	"strings"

	"github.com/openmap/openmap/tools/simulator/internal/estate"
	"github.com/openmap/openmap/tools/simulator/internal/protocols/winrm"
	"github.com/openmap/openmap/tools/simulator/internal/sim"
	"github.com/openmap/openmap/tools/simulator/internal/vendors/windows"
)

const (
	signature    = "Get-SmbShare"
	fileRole     = "-file-"
	minShares    = 1
	stateOnline  = 1
	stateOffline = 2
	rightFull    = 0
	rightChange  = 1
	rightRead    = 2
	allow        = 0
	enumAccess   = 0
	maxSessions  = 120
	offlineOneIn = 4
	encryptOneIn = 3
	jobTimeoutMs = 300000
)

type Vendor struct{}

func (Vendor) ID() string             { return "windows-smb" }
func (Vendor) Collector() string      { return "nas" }
func (Vendor) Requirements() []string { return []string{"REQ-DISC-016"} }

type catalogueShare struct{ name, folder, description string }

var catalogue = []catalogueShare{
	{"Departments", `D:\Shares\Departments`, "Department shares"},
	{"Users", `D:\Shares\Users`, "Home folders"},
	{"Profiles$", `D:\Profiles`, "Roaming profiles"},
	{"Scans", `D:\Shares\Scans`, "Scanner drop folder"},
	{"Archive", `E:\Archive`, "Statement archive"},
}

// Share is one simulated SMB share.
type Share struct {
	Name, Path, Description string
	State, Sessions         int
	Encrypt                 bool
	Access                  []Access
}

// Access is one Get-SmbShareAccess entry.
type Access struct {
	Account string
	Right   int
}

// Server is one simulated Windows file server.
type Server struct {
	Host   *windows.Host
	Shares []Share
}

func netbiosDomain(fqdn string) string {
	parts := strings.Split(fqdn, ".")
	if len(parts) < 2 {
		return "WORKGROUP"
	}
	return strings.ToUpper(parts[1])
}

// Servers lists the estate's Windows file servers with their seeded shares.
func Servers(e *estate.Estate) []*Server {
	var out []*Server
	for _, h := range windows.Hosts(e) {
		if !strings.Contains(h.CI.Name, fileRole) {
			continue
		}
		fqdn := h.FQDN()
		dom := netbiosDomain(fqdn)
		n := winrm.Pick(minShares, len(catalogue), fqdn, "shares")
		s := &Server{Host: h}
		for i := 0; i < n; i++ {
			c := catalogue[i]
			state := stateOnline
			if i == n-1 && n > minShares && winrm.Pick(0, offlineOneIn-1, fqdn, "offline") == 0 {
				state = stateOffline
			}
			sessions := 0
			if state == stateOnline {
				sessions = winrm.Pick(0, maxSessions, fqdn, c.name)
			}
			access := []Access{{Account: `BUILTIN\Administrators`, Right: rightFull}, {Account: dom + `\Domain Users`, Right: rightChange}}
			if c.name == "Archive" {
				access = []Access{{Account: `BUILTIN\Administrators`, Right: rightFull}, {Account: dom + `\Auditors`, Right: rightRead}}
			}
			s.Shares = append(s.Shares, Share{Name: c.name, Path: c.folder, Description: c.description, State: state, Sessions: sessions,
				Encrypt: winrm.Pick(0, encryptOneIn-1, fqdn, c.name, "enc") == 0, Access: access})
		}
		out = append(out, s)
	}
	return out
}

// listOrOne is ConvertTo-Json's shape for pipeline output: one object alone, several as an array.
func listOrOne(items []any) any {
	if len(items) == 1 {
		return items[0]
	}
	return items
}

// Script answers the collector's SMB script on the server.
func (s *Server) Script(script string) winrm.Output {
	if !strings.Contains(script, signature) {
		return winrm.Unsupported(winrm.FirstCmdlet(script))
	}
	shares, access := []any{}, []any{}
	for _, sh := range s.Shares {
		shares = append(shares, map[string]any{"Name": sh.Name, "Path": sh.Path, "Description": sh.Description, "ShareState": sh.State, "ScopeName": "*",
			"CurrentUsers": sh.Sessions, "EncryptData": sh.Encrypt, "FolderEnumerationMode": enumAccess})
		for _, a := range sh.Access {
			access = append(access, map[string]any{"Name": sh.Name, "AccountName": a.Account, "AccessRight": a.Right, "AccessControlType": allow})
		}
	}
	out := winrm.Lines("@@OPENMAP:host@@", s.Host.FQDN(), "@@OPENMAP:smb@@") + winrm.JSON(listOrOne(shares)) + winrm.Lines("@@OPENMAP:smbaccess@@") + winrm.JSON(listOrOne(access))
	return winrm.Output{Stdout: out}
}

func (Vendor) Start(_ context.Context, e *estate.Estate, env *sim.Env) (*sim.Endpoint, error) {
	servers := Servers(e)
	keys := make([]string, len(servers))
	byKey := map[string]*Server{}
	for i, s := range servers {
		keys[i] = s.Host.FQDN()
		byKey[keys[i]] = s
	}
	return winrm.Serve(env, keys, func(k string) winrm.Script { return byKey[k].Script })
}

// ShareName is the collector's nas_share name for an SMB share.
func ShareName(fqdn, share string) string { return `\\` + fqdn + `\` + share }

func (Vendor) Runs(e *estate.Estate, ep *sim.Endpoint, env *sim.Env) []sim.Run {
	servers := Servers(e)
	keys := make([]string, len(servers))
	byKey := map[string]*Server{}
	for i, s := range servers {
		keys[i] = s.Host.FQDN()
		byKey[keys[i]] = s
	}
	return windows.Plan("smb-file-servers", ep, env, keys, map[string]any{"mode": "windows"}, jobTimeoutMs, func(x *sim.Expect, fqdn string) {
		for _, sh := range byKey[fqdn].Shares {
			name := ShareName(fqdn, sh.Name)
			x.CIs = append(x.CIs, sim.ExpectCI{Type: "nas_share", Name: name, Identity: map[string]string{"arrayRef": fqdn, "protocol": "smb", "path": sh.Path}})
			x.RelFromRef("contains", "host", map[string]string{"fqdn": fqdn}, "nas_share", name)
		}
	})
}
