// REQ-DISC-016 — NAS and file-share enumeration: SMB shares on Windows file servers over WinRM
// (Get-SmbShare with their access entries and session counts), Samba shares and NFS exports on
// Linux servers over SSH (testparm, exportfs), and NFS exports on any appliance agentlessly through
// the MOUNT protocol (NetApp, PowerScale, TrueNAS, knfsd). Every share becomes a `nas_share` CI on the
// serving host so the dependency map can tie mounted clients to the exports they rely on.
package nas

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/collector"
	"github.com/openmap/openmap/apps/collectors/internal/contract"
	"github.com/openmap/openmap/apps/collectors/internal/sshexec"
	"github.com/openmap/openmap/apps/collectors/internal/winrmexec"
)

const (
	collectorID   = "nas"
	version       = "0.1.0"
	evidenceKind  = "cli_transcript"
	optionMode    = "mode"
	optionPortmap = "portmapPort"
	modeWindows   = "windows"
	modeLinux     = "linux"
	modeNFS       = "nfs"
	protocolSMB   = "smb"
	protocolNFS   = "nfs"

	typeShare    = "nas_share"
	typeHost     = "host"
	relContains  = "contains"
	sectionHost  = "host"
	sectionSmb   = "smb"
	sectionSmbAc = "smbaccess"
	sectionNfs   = "nfs"
	sectionSamba = "samba"
)

type Collector struct{}

func (Collector) Manifest() contract.Manifest {
	return contract.Manifest{
		ID: collectorID, Family: "nas", Version: version, Language: "go",
		Protocols: []string{"winrm", "ssh", "sunrpc"}, CredentialTypes: []string{"password", "ssh_key", "none"},
		TargetKinds: []string{"host"}, Emits: []string{typeShare},
		ContractVersion: contract.Version,
	}
}

// Share is one exported file system, whichever protocol serves it.
type Share struct {
	Name        string
	Path        string
	Protocol    string
	Description string
	State       string
	Clients     []string
	Options     []string
	Access      []Access
	Sessions    int
}

// Access is one SMB share permission entry.
type Access struct {
	Account string
	Right   string
	Allow   bool
}

// WindowsScript prints the server's DNS name, then lists SMB shares, their access entries and open session counts as
// JSON sections.
const WindowsScript = `$ErrorActionPreference = 'Stop'
Write-Output '@@OPENMAP:host@@'
try { [System.Net.Dns]::GetHostEntry($env:COMPUTERNAME).HostName } catch { $env:COMPUTERNAME }
Write-Output '@@OPENMAP:smb@@'
Get-SmbShare | Where-Object { $_.Special -eq $false } | Select-Object Name, Path, Description, ShareState, ScopeName, CurrentUsers, EncryptData, FolderEnumerationMode | ConvertTo-Json -Compress -Depth 3
Write-Output '@@OPENMAP:smbaccess@@'
Get-SmbShare | Where-Object { $_.Special -eq $false } | Get-SmbShareAccess | Select-Object Name, AccountName, AccessRight, AccessControlType | ConvertTo-Json -Compress -Depth 3
`

type smbShare struct {
	Name         string `json:"Name"`
	Path         string `json:"Path"`
	Description  string `json:"Description"`
	ShareState   any    `json:"ShareState"`
	ScopeName    string `json:"ScopeName"`
	CurrentUsers int    `json:"CurrentUsers"`
	EncryptData  bool   `json:"EncryptData"`
}

type smbAccess struct {
	Name              string `json:"Name"`
	AccountName       string `json:"AccountName"`
	AccessRight       any    `json:"AccessRight"`
	AccessControlType any    `json:"AccessControlType"`
}

func listOrOne[T any](raw string) ([]T, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, nil
	}
	if strings.HasPrefix(raw, "[") {
		var list []T
		return list, json.Unmarshal([]byte(raw), &list)
	}
	var one T
	if err := json.Unmarshal([]byte(raw), &one); err != nil {
		return nil, err
	}
	return []T{one}, nil
}

func enumString(v any, names map[float64]string) string {
	switch t := v.(type) {
	case string:
		return strings.ToLower(t)
	case float64:
		if n, ok := names[t]; ok {
			return n
		}
	}
	return ""
}

var shareStates = map[float64]string{0: "pending", 1: "online", 2: "offline"}
var accessRights = map[float64]string{0: "full", 1: "change", 2: "read", 3: "custom"}
var accessTypes = map[float64]string{0: "allow", 1: "deny"}

// ParseWindows decodes the two JSON sections of WindowsScript.
func ParseWindows(stdout string) ([]Share, error) {
	sections, _ := sshexec.Split(stdout)
	shares, err := listOrOne[smbShare](sections[sectionSmb])
	if err != nil {
		return nil, collector.Errorf(contract.ErrParse, false, "Get-SmbShare output is not JSON: %v", err)
	}
	access, err := listOrOne[smbAccess](sections[sectionSmbAc])
	if err != nil {
		return nil, collector.Errorf(contract.ErrParse, false, "Get-SmbShareAccess output is not JSON: %v", err)
	}
	byName := map[string][]Access{}
	for _, a := range access {
		byName[a.Name] = append(byName[a.Name], Access{Account: a.AccountName, Right: enumString(a.AccessRight, accessRights), Allow: enumString(a.AccessControlType, accessTypes) != "deny"})
	}
	out := make([]Share, 0, len(shares))
	for _, s := range shares {
		state := enumString(s.ShareState, shareStates)
		out = append(out, Share{Name: s.Name, Path: s.Path, Protocol: protocolSMB, Description: s.Description, State: state, Sessions: s.CurrentUsers, Access: byName[s.Name], Options: encryptOption(s.EncryptData)})
	}
	return out, nil
}

// WindowsHost is the file server's DNS name from WindowsScript ("" when the section is missing), so shares are
// contained by the server itself rather than by the address the job targeted.
func WindowsHost(stdout string) string {
	sections, _ := sshexec.Split(stdout)
	return strings.ToLower(strings.TrimSuffix(strings.TrimSpace(sections[sectionHost]), "."))
}

func encryptOption(encrypt bool) []string {
	if encrypt {
		return []string{"encrypt"}
	}
	return []string{}
}

// LinuxScript dumps the effective Samba share configuration and the NFS export table.
var LinuxScript = sshexec.MarkerPrintf(sectionSamba) + "; testparm -s 2>/dev/null || true;\n" +
	sshexec.MarkerPrintf(sectionNfs) + "; exportfs -v 2>/dev/null || sudo -n exportfs -v 2>/dev/null || cat /etc/exports 2>/dev/null;\n"

// ParseSamba reads testparm's smb.conf dump: [share] sections with path and comment; [global], [homes] and
// [printers] are not file shares.
func ParseSamba(text string) []Share {
	var out []Share
	var cur *Share
	flush := func() {
		if cur != nil && cur.Path != "" {
			out = append(out, *cur)
		}
		cur = nil
	}
	for _, raw := range strings.Split(text, "\n") {
		line := strings.TrimSpace(raw)
		if strings.HasPrefix(line, "[") && strings.HasSuffix(line, "]") {
			flush()
			name := strings.TrimSuffix(strings.TrimPrefix(line, "["), "]")
			if lower := strings.ToLower(name); lower == "global" || lower == "homes" || lower == "printers" || lower == "print$" {
				continue
			}
			cur = &Share{Name: name, Protocol: protocolSMB, State: "online", Options: []string{}, Clients: []string{}}
			continue
		}
		if cur == nil {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		key = strings.ToLower(strings.TrimSpace(key))
		value = strings.TrimSpace(value)
		switch key {
		case "path":
			cur.Path = value
		case "comment":
			cur.Description = value
		case "valid users", "hosts allow":
			for _, c := range strings.FieldsFunc(value, func(r rune) bool { return r == ',' || r == ' ' }) {
				cur.Clients = append(cur.Clients, c)
			}
		case "read only", "writeable", "writable", "guest ok", "browseable", "available":
			cur.Options = append(cur.Options, key+"="+strings.ToLower(value))
			if key == "available" && strings.EqualFold(value, "no") {
				cur.State = "offline"
			}
		}
	}
	flush()
	return out
}

// ParseExports reads `exportfs -v` output (path, then client(options), options possibly wrapped onto the
// next line) or a plain /etc/exports file.
func ParseExports(text string) []Share {
	var out []Share
	byPath := map[string]int{}
	pending := ""
	for _, raw := range strings.Split(text, "\n") {
		line := strings.TrimSpace(raw)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if pending != "" {
			line = pending + " " + line
			pending = ""
		}
		fields := strings.Fields(line)
		if len(fields) == 0 {
			continue
		}
		path := fields[0]
		if !strings.HasPrefix(path, "/") {
			continue
		}
		if len(fields) == 1 {
			pending = path
			continue
		}
		idx, ok := byPath[path]
		if !ok {
			out = append(out, Share{Name: path, Path: path, Protocol: protocolNFS, State: "online", Clients: []string{}, Options: []string{}})
			idx = len(out) - 1
			byPath[path] = idx
		}
		for _, spec := range fields[1:] {
			client, opts, hasOpts := strings.Cut(spec, "(")
			if client == "" {
				client = "*"
			}
			out[idx].Clients = append(out[idx].Clients, client)
			if hasOpts {
				for _, o := range strings.Split(strings.TrimSuffix(opts, ")"), ",") {
					if o = strings.TrimSpace(o); o != "" && !contains(out[idx].Options, o) {
						out[idx].Options = append(out[idx].Options, o)
					}
				}
			}
		}
	}
	return out
}

func contains(list []string, v string) bool {
	for _, item := range list {
		if item == v {
			return true
		}
	}
	return false
}

// FromExports converts MOUNT EXPORT entries into shares.
func FromExports(list []Export) []Share {
	out := make([]Share, 0, len(list))
	for _, e := range list {
		clients := e.Groups
		if len(clients) == 0 {
			clients = []string{"*"}
		}
		out = append(out, Share{Name: e.Path, Path: e.Path, Protocol: protocolNFS, State: "online", Clients: clients, Options: []string{}})
	}
	return out
}

// Emit converts shares into nas_share CIs contained by the serving host.
func Emit(shares []Share, target contract.Target, raw []byte, at time.Time) collector.Observation {
	obs := collector.Observation{Evidence: []collector.RawEvidence{{Kind: evidenceKind, Data: raw}}}
	hostRef := strings.ToLower(target.Value)
	host := contract.CiRef{Type: typeHost, Identity: map[string]string{"fqdn": hostRef}}
	for _, s := range shares {
		identity := map[string]string{"arrayRef": hostRef, "protocol": s.Protocol, "path": s.Path}
		access := make([]map[string]any, 0, len(s.Access))
		for _, a := range s.Access {
			access = append(access, map[string]any{"account": a.Account, "right": a.Right, "allow": a.Allow})
		}
		attrs := map[string]any{"name": s.Name, "path": s.Path, "protocol": s.Protocol, "description": s.Description, "state": s.State, "clients": s.Clients, "options": s.Options, "access": access, "sessions": s.Sessions, "host": hostRef, "source": collectorID}
		if s.State == "offline" {
			attrs["health"] = "down"
		} else if s.State == "online" {
			attrs["health"] = "healthy"
		}
		name := s.Name
		if s.Protocol == protocolSMB {
			name = "\\\\" + hostRef + "\\" + s.Name
		} else {
			name = hostRef + ":" + s.Path
		}
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeShare, Identity: identity, Name: name, Attributes: attrs, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
		obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relContains, From: host, To: contract.CiRef{Type: typeShare, Identity: identity}, Attributes: map[string]any{"protocol": s.Protocol}, ObservedAt: at})
	}
	return obs
}

func (Collector) Collect(ctx context.Context, target contract.Target, cred *contract.Credential, options map[string]any) (collector.Observation, error) {
	mode, _ := options[optionMode].(string)
	switch strings.ToLower(mode) {
	case modeWindows:
		out, err := winrmexec.Run(ctx, target, cred, options, WindowsScript)
		if err != nil {
			return collector.Observation{}, err
		}
		shares, err := ParseWindows(out.Stdout)
		if err != nil {
			return collector.Observation{}, err
		}
		server := target
		if name := WindowsHost(out.Stdout); name != "" {
			server.Value = name
		}
		return Emit(shares, server, []byte(out.Stdout), time.Now().UTC()), nil
	case modeLinux:
		out, err := sshexec.Run(ctx, target, cred, options, LinuxScript)
		if err != nil {
			return collector.Observation{}, err
		}
		sections, _ := sshexec.Split(string(out.Stdout))
		shares := append(ParseSamba(sections[sectionSamba]), ParseExports(sections[sectionNfs])...)
		return Emit(shares, target, out.Stdout, time.Now().UTC()), nil
	case modeNFS, "":
		port, err := MountPort(ctx, target.Value, Rpcbind(options))
		if err != nil {
			return collector.Observation{}, collector.Errorf(contract.ErrUnreachable, true, "%s: rpcbind: %v", target.Value, err)
		}
		if port == 0 {
			return collector.Observation{}, collector.Errorf(contract.ErrUnsupportedDevice, false, "%s does not register the MOUNT protocol (no NFSv3 exports)", target.Value)
		}
		exports, err := Exports(ctx, target.Value, port)
		if err != nil {
			return collector.Observation{}, collector.Errorf(contract.ErrUnreachable, true, "%s: mount export: %v", target.Value, err)
		}
		raw, _ := json.Marshal(exports)
		return Emit(FromExports(exports), target, raw, time.Now().UTC()), nil
	default:
		return collector.Observation{}, collector.Errorf(contract.ErrInternal, false, "nas mode %q must be windows, linux or nfs", mode)
	}
}
