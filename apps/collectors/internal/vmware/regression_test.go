// T-385 REQ-QA-005 REQ-DISC-005 — regressions the simulated vCenter exposed: caCertPem pins the VMCA root
// for the session and every API call, the legacy /rest namespace names list filters filter.<field>, and
// its VM NIC and disk maps arrive as [{key, value}] arrays rather than JSON objects.
package vmware

import (
	"context"
	"encoding/json"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"testing"
)

func TestCACertPemPinsVcenterChain(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`"pinned-session"`))
	}))
	defer srv.Close()
	u, _ := url.Parse(srv.URL)
	port, _ := strconv.Atoi(u.Port())
	caPem := string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: srv.Certificate().Raw}))

	pinned, err := NewClient(u.Hostname(), port, "u", "p", true, caPem)
	if err != nil {
		t.Fatal(err)
	}
	if err := pinned.Login(context.Background()); err != nil {
		t.Fatalf("pinned VMCA root rejected: %v", err)
	}
	unpinned, err := NewClient(u.Hostname(), port, "u", "p", true, "")
	if err != nil {
		t.Fatal(err)
	}
	if err := unpinned.Login(context.Background()); err == nil {
		t.Fatal("an unknown chain was accepted with verifyTls on")
	}
	if _, err := NewClient(u.Hostname(), port, "u", "p", true, "not a certificate"); err == nil {
		t.Fatal("a caCertPem without a certificate was accepted")
	}
}

func TestLegacyPathRenamesFilters(t *testing.T) {
	c := &Client{legacy: true}
	if got := c.path("/api/vcenter/vm?hosts=host-10"); got != "/rest/vcenter/vm?filter.hosts=host-10" {
		t.Fatalf("legacy vm filter: %s", got)
	}
	if got := c.path("/api/vcenter/host"); got != "/rest/vcenter/host" {
		t.Fatalf("legacy plain path: %s", got)
	}
	if got := (&Client{}).path("/api/vcenter/vm?hosts=host-10"); got != "/api/vcenter/vm?hosts=host-10" {
		t.Fatalf("modern path rewritten: %s", got)
	}
}

func TestKeyedMapAcceptsBothEnvelopes(t *testing.T) {
	var modern, legacy VMDetail
	if err := json.Unmarshal([]byte(`{"nics":{"4000":{"mac_address":"00:50:56:aa:bb:01"}},"disks":{"2000":{"capacity":42}}}`), &modern); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(`{"nics":[{"key":"4000","value":{"mac_address":"00:50:56:aa:bb:01"}}],"disks":[{"key":"2000","value":{"capacity":42}}]}`), &legacy); err != nil {
		t.Fatal(err)
	}
	for _, d := range []VMDetail{modern, legacy} {
		if d.Nics["4000"].MacAddress != "00:50:56:aa:bb:01" || d.Disks["2000"].Capacity != 42 {
			t.Fatalf("map not decoded: %+v", d)
		}
	}
}
