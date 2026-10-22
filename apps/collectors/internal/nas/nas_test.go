// T-069 REQ-DISC-016 — Windows SMB shares from a Get-SmbShare JSON transcript, Samba and exportfs text from a
// Linux transcript, and NFS exports from an in-process rpcbind + MOUNT v3 server speaking ONC RPC over TCP.
package nas

import (
	"context"
	"encoding/binary"
	"io"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

const windowsTranscript = `@@OPENMAP:smb@@
[{"Name":"Finance","Path":"D:\\Shares\\Finance","Description":"Finance team","ShareState":1,"ScopeName":"*","CurrentUsers":7,"EncryptData":true,"FolderEnumerationMode":0},{"Name":"Public","Path":"D:\\Shares\\Public","Description":"","ShareState":2,"ScopeName":"*","CurrentUsers":0,"EncryptData":false,"FolderEnumerationMode":0}]
@@OPENMAP:smbaccess@@
[{"Name":"Finance","AccountName":"BANK\\finance-rw","AccessRight":1,"AccessControlType":0},{"Name":"Finance","AccountName":"BANK\\auditors","AccessRight":2,"AccessControlType":0},{"Name":"Public","AccountName":"Everyone","AccessRight":2,"AccessControlType":0}]
`

const linuxTranscript = `@@OPENMAP:samba@@
# Global parameters
[global]
	server string = Samba Server
	workgroup = BANK

[homes]
	browseable = No
	read only = No

[archive]
	comment = Statement archive
	path = /srv/samba/archive
	read only = Yes
	valid users = @archive-readers, svc-batch

[scratch]
	path = /srv/samba/scratch
	available = No
	writeable = Yes
@@OPENMAP:nfs@@
/export/home  	10.191.0.0/16(sync,wdelay,hide,no_subtree_check,sec=sys,rw,secure,root_squash,no_all_squash)
/export/backup
		10.191.9.0/24(sync,wdelay,hide,no_subtree_check,sec=sys,ro,secure,root_squash,no_all_squash)
/export/backup  	backup02.bank.local(sync,wdelay,hide,no_subtree_check,sec=sys,rw,secure,no_root_squash,no_all_squash)
`

func TestParseWindows(t *testing.T) {
	shares, err := ParseWindows(windowsTranscript)
	if err != nil {
		t.Fatal(err)
	}
	if len(shares) != 2 || shares[0].Name != "Finance" || shares[0].State != "online" || shares[0].Sessions != 7 || len(shares[0].Access) != 2 || shares[0].Access[0].Right != "change" || !shares[0].Access[0].Allow || shares[0].Options[0] != "encrypt" {
		t.Fatalf("finance share wrong: %+v", shares[0])
	}
	if shares[1].State != "offline" || len(shares[1].Access) != 1 || shares[1].Access[0].Account != "Everyone" {
		t.Fatalf("public share wrong: %+v", shares[1])
	}
	obs := Emit(shares, contract.Target{Kind: "host", Value: "fs-ryd-01.bank.local"}, []byte(windowsTranscript), time.Now())
	if len(obs.Cis) != 2 || obs.Cis[0].Type != typeShare || obs.Cis[0].Identity["protocol"] != protocolSMB || obs.Cis[0].Name != `\\fs-ryd-01.bank.local\Finance` || obs.Cis[1].Attributes["health"] != "down" || len(obs.Relationships) != 2 {
		t.Fatalf("emit wrong: %+v", obs.Cis)
	}
}

func TestParseLinux(t *testing.T) {
	sections := map[string]string{}
	key := ""
	for _, line := range strings.Split(linuxTranscript, "\n") {
		if strings.HasPrefix(line, "@@OPENMAP:") {
			key = strings.TrimSuffix(strings.TrimPrefix(line, "@@OPENMAP:"), "@@")
			continue
		}
		sections[key] += line + "\n"
	}
	samba := ParseSamba(sections[sectionSamba])
	if len(samba) != 2 || samba[0].Name != "archive" || samba[0].Path != "/srv/samba/archive" || samba[0].Description != "Statement archive" || len(samba[0].Clients) != 2 || samba[1].State != "offline" {
		t.Fatalf("samba wrong: %+v", samba)
	}
	nfs := ParseExports(sections[sectionNfs])
	if len(nfs) != 2 || nfs[0].Path != "/export/home" || nfs[0].Clients[0] != "10.191.0.0/16" || !contains(nfs[0].Options, "rw") {
		t.Fatalf("nfs home wrong: %+v", nfs)
	}
	if len(nfs[1].Clients) != 2 || nfs[1].Clients[1] != "backup02.bank.local" || !contains(nfs[1].Options, "ro") || !contains(nfs[1].Options, "no_root_squash") {
		t.Fatalf("nfs backup wrong: %+v", nfs[1])
	}
}

// fakeRPC answers rpcbind GETPORT with its own port and MOUNT EXPORT with two exports.
func fakeRPC(t *testing.T) (string, int) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	port := ln.Addr().(*net.TCPAddr).Port
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
				xid := binary.BigEndian.Uint32(body[0:4])
				program := binary.BigEndian.Uint32(body[12:16])
				procedure := binary.BigEndian.Uint32(body[20:24])
				w := &xdrWriter{}
				w.uint32(xid)
				w.uint32(rpcReply)
				w.uint32(rpcMsgAccepted)
				w.uint32(rpcAuthNull)
				w.uint32(0)
				w.uint32(rpcSuccess)
				switch {
				case program == rpcbindProgram && procedure == rpcbindGetPort:
					w.uint32(uint32(port))
				case program == mountProgram && procedure == mountExportProc:
					w.uint32(1)
					w.opaque([]byte("/vol/home"))
					w.uint32(1)
					w.opaque([]byte("10.191.0.0/16"))
					w.uint32(1)
					w.opaque([]byte("app-ryd-07"))
					w.uint32(0)
					w.uint32(1)
					w.opaque([]byte("/vol/backup"))
					w.uint32(0)
					w.uint32(0)
				default:
					w.uint32(0)
				}
				frame := binary.BigEndian.AppendUint32(nil, uint32(len(w.buf))|recordLastFlag)
				_, _ = c.Write(append(frame, w.buf...))
			}(conn)
		}
	}()
	return "127.0.0.1", port
}

func TestNfsMountExports(t *testing.T) {
	host, port := fakeRPC(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	mountPort, err := MountPort(ctx, host, port)
	if err != nil || mountPort != port {
		t.Fatalf("getport wrong: %d %v", mountPort, err)
	}
	exports, err := Exports(ctx, host, mountPort)
	if err != nil {
		t.Fatal(err)
	}
	if len(exports) != 2 || exports[0].Path != "/vol/home" || len(exports[0].Groups) != 2 || exports[0].Groups[1] != "app-ryd-07" || len(exports[1].Groups) != 0 {
		t.Fatalf("exports wrong: %+v", exports)
	}
	obs, err := Collector{}.Collect(ctx, contract.Target{Kind: "host", Value: host}, nil, map[string]any{optionMode: modeNFS, optionPortmap: port})
	if err != nil {
		t.Fatal(err)
	}
	if len(obs.Cis) != 2 || obs.Cis[1].Attributes["clients"].([]string)[0] != "*" || obs.Cis[0].Identity["path"] != "/vol/home" {
		t.Fatalf("collect wrong: %+v", obs.Cis)
	}
}
