// T-376 REQ-QA-005 REQ-DISC-016 — regression for a gap the simulated WinRM file servers exposed: SMB shares were
// contained by a host whose fqdn was the job target, so a server discovered by address produced `\\10.x.y.z\share`
// names and a host reference that never merges with the server's host CI. The Windows script now prints the
// server's DNS name first and the shares hang off that name.
package nas

import (
	"strings"
	"testing"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

const windowsHostTranscript = "@@OPENMAP:host@@\r\nFS-RYD-01.bank.local.\r\n@@OPENMAP:smb@@\r\n" +
	`{"Name":"Finance","Path":"D:\\Shares\\Finance","Description":"Finance team","ShareState":1,"ScopeName":"*","CurrentUsers":7,"EncryptData":true,"FolderEnumerationMode":0}` + "\r\n" +
	"@@OPENMAP:smbaccess@@\r\n" + `{"Name":"Finance","AccountName":"BANK\\finance-rw","AccessRight":1,"AccessControlType":0}` + "\r\n"

func TestREQDISC016_T376_WindowsSharesHangOffTheServerName(t *testing.T) {
	if !strings.HasPrefix(WindowsScript, "$ErrorActionPreference = 'Stop'\nWrite-Output '@@OPENMAP:host@@'") {
		t.Fatalf("the Windows script must print the server name section first:\n%s", WindowsScript)
	}
	if got := WindowsHost(windowsHostTranscript); got != "fs-ryd-01.bank.local" {
		t.Fatalf("server name = %q", got)
	}
	if got := WindowsHost(windowsTranscript); got != "" {
		t.Fatalf("a transcript without the host section must give no name, got %q", got)
	}
	shares, err := ParseWindows(windowsHostTranscript)
	if err != nil || len(shares) != 1 || shares[0].Access[0].Account != `BANK\finance-rw` {
		t.Fatalf("shares wrong: %+v %v", shares, err)
	}
	obs := Emit(shares, contract.Target{Kind: "host", Value: WindowsHost(windowsHostTranscript)}, []byte(windowsHostTranscript), time.Now())
	if obs.Cis[0].Name != `\\fs-ryd-01.bank.local\Finance` || obs.Relationships[0].From.Identity["fqdn"] != "fs-ryd-01.bank.local" {
		t.Fatalf("share not contained by the server name: %+v %+v", obs.Cis[0], obs.Relationships[0])
	}
}
