// T-377 REQ-QA-005 REQ-DISC-022 — regression for two gaps the simulated Windows DHCP server exposed: scopes
// referenced the address the job targeted instead of the server (serverRef 10.x.y.z never merges with the
// estate's scopes), and the option values the script fetched were never read, so Windows scopes had no router or
// DNS servers. The script now prints the server's DNS name and per-scope options; scope options win over server
// options.
package dhcp

import (
	"strings"
	"testing"
	"time"
)

const windowsServerSample = `{"server":"DHCP-RYD-01.bank.local","scopes":[` +
	`{"ScopeId":{"Address":16448,"AddressFamily":2,"IPAddressToString":"10.64.0.0"},"SubnetMask":{"IPAddressToString":"255.255.255.0"},"Name":"BR-001","StartRange":{"IPAddressToString":"10.64.0.100"},"EndRange":{"IPAddressToString":"10.64.0.250"},"LeaseDuration":{"TotalSeconds":86400},"State":"Active"},` +
	`{"ScopeId":{"IPAddressToString":"10.64.1.0"},"SubnetMask":{"IPAddressToString":"255.255.255.0"},"Name":"BR-002","StartRange":{"IPAddressToString":"10.64.1.100"},"EndRange":{"IPAddressToString":"10.64.1.250"},"LeaseDuration":{"TotalSeconds":86400},"State":"Active"}],` +
	`"leases":[],"options":[` +
	`{"OptionId":6,"Value":["10.4.0.26","10.4.0.27"],"ScopeId":null},{"OptionId":15,"Value":["bank.local"],"ScopeId":null},` +
	`{"OptionId":3,"Value":["10.64.0.1"],"ScopeId":"10.64.0.0"},{"OptionId":3,"Value":["10.64.1.1"],"ScopeId":"10.64.1.0"},{"OptionId":6,"Value":["10.20.0.10"],"ScopeId":"10.64.1.0"}]}`

func TestREQDISC022_T377_WindowsServerNameAndOptions(t *testing.T) {
	if !strings.Contains(WindowsScript, "GetHostEntry") || !strings.Contains(WindowsScript, "Get-DhcpServerv4OptionValue -ScopeId") {
		t.Fatalf("the Windows script must print the server name and per-scope options:\n%s", WindowsScript)
	}
	if got := WindowsServer("banner\r\n" + windowsServerSample); got != "dhcp-ryd-01.bank.local" {
		t.Fatalf("server = %q", got)
	}
	if got := WindowsServer(windowsSample); got != "" {
		t.Fatalf("a document without a server name must give none, got %q", got)
	}
	scopes, _, err := ParseWindows(windowsServerSample)
	if err != nil || len(scopes) != 2 {
		t.Fatalf("scopes: %+v %v", scopes, err)
	}
	if scopes[0].Router != "10.64.0.1" || strings.Join(scopes[0].DNS, ",") != "10.4.0.26,10.4.0.27" {
		t.Fatalf("server-level DNS must apply where the scope sets none: %+v", scopes[0])
	}
	if scopes[1].Router != "10.64.1.1" || strings.Join(scopes[1].DNS, ",") != "10.20.0.10" {
		t.Fatalf("scope options must win: %+v", scopes[1])
	}
	obs := Emit(WindowsServer(windowsServerSample), scopes, nil, []byte(windowsServerSample), time.Now())
	if obs.Cis[0].Identity["serverRef"] != "dhcp-ryd-01.bank.local" || obs.Cis[0].Attributes["router"] != "10.64.0.1" {
		t.Fatalf("scope emission wrong: %+v", obs.Cis[0])
	}
}
