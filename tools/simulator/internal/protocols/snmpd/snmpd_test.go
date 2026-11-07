// T-400 REQ-QA-005 REQ-DISC-001 — the simulated SNMP agent answers gosnmp (the collector's client) the way a
// device agent does: lexicographic GETNEXT/GETBULK order, GETBULK truncation to the message size, v1 error
// semantics, and SNMPv3 USM discovery with every auth/priv protocol pair the collector can configure.
package snmpd

import (
	"strings"
	"testing"
	"time"

	g "github.com/gosnmp/gosnmp"
)

const (
	testCommunity = "sim-community"
	testRows      = 60
	testTimeout   = 2 * time.Second
	shortTimeout  = 300 * time.Millisecond
	ifDescr       = ".1.3.6.1.2.1.2.2.1.2"
	ifSpeed10     = ".1.3.6.1.2.1.2.2.1.10"
	sysName       = ".1.3.6.1.2.1.1.5.0"
	hcCounter     = ".1.3.6.1.2.1.31.1.1.1.6.1"
)

func testMIB() *MIB {
	m := NewMIB()
	m.Str(".1.3.6.1.2.1.1.1.0", "simulated agent")
	m.Str(sysName, "sim-01")
	// Rows inserted out of order: the tree must still serve them in numeric order.
	for i := testRows; i >= 1; i-- {
		m.Str(Index(ifDescr, i), strings.Repeat("x", 40)+"-port")
		m.Counter(Index(ifSpeed10, i), uint32(i))
	}
	m.Counter64(hcCounter, 1)
	return m
}

func listen(t *testing.T, cfg Config) *Agent {
	t.Helper()
	a, err := Listen("127.0.0.1", testMIB(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = a.Close() })
	return a
}

func client(t *testing.T, a *Agent, c *g.GoSNMP) *g.GoSNMP {
	t.Helper()
	c.Target, c.Port, c.Transport = "127.0.0.1", uint16(a.Port()), "udp"
	if c.Timeout == 0 {
		c.Timeout = testTimeout
	}
	c.MaxRepetitions = 25
	if err := c.Connect(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.Conn.Close() })
	return c
}

func walkNames(t *testing.T, c *g.GoSNMP, root string, bulk bool) []string {
	t.Helper()
	var names []string
	fn := func(p g.SnmpPDU) error { names = append(names, p.Name); return nil }
	var err error
	if bulk {
		err = c.BulkWalk(root, fn)
	} else {
		err = c.Walk(root, fn)
	}
	if err != nil {
		t.Fatal(err)
	}
	return names
}

func TestV2cOrderingBulkAndExceptions(t *testing.T) {
	a := listen(t, Config{Community: testCommunity, V2c: true})
	c := client(t, a, &g.GoSNMP{Version: g.Version2c, Community: testCommunity})
	names := walkNames(t, c, ifDescr, true)
	if len(names) != testRows || names[0] != ifDescr+".1" || names[1] != ifDescr+".2" || names[9] != ifDescr+".10" {
		t.Fatalf("bulk walk out of order or incomplete: %d rows, first %v", len(names), names[:3])
	}
	// The 60 forty-byte rows cannot fit one 1472-octet response: the walk must have taken several requests.
	if a.Stats.Requests.Load() < 3 {
		t.Fatalf("GETBULK was not truncated to the message size: %d requests", a.Stats.Requests.Load())
	}
	next, err := c.GetNext([]string{ifDescr + "." + "60"})
	if err != nil || next.Variables[0].Name != ifSpeed10+".1" {
		t.Fatalf("GETNEXT past the last ifDescr must reach column 10 row 1, got %v %v", next, err)
	}
	res, err := c.Get([]string{sysName, ".1.3.6.1.2.1.1.99.0", ifDescr + ".999"})
	if err != nil {
		t.Fatal(err)
	}
	if string(res.Variables[0].Value.([]byte)) != "sim-01" || res.Variables[1].Type != g.NoSuchObject || res.Variables[2].Type != g.NoSuchInstance {
		t.Fatalf("v2c GET exceptions wrong: %+v", res.Variables)
	}
	end, err := c.GetNext([]string{hcCounter})
	if err != nil || end.Variables[0].Type != g.EndOfMibView {
		t.Fatalf("GETNEXT past the MIB must answer endOfMibView, got %+v %v", end, err)
	}
}

func TestV1ErrorsAndCounter64(t *testing.T) {
	a := listen(t, Config{Community: testCommunity, V1: true})
	c := client(t, a, &g.GoSNMP{Version: g.Version1, Community: testCommunity})
	res, err := c.Get([]string{sysName, ".1.3.6.1.2.1.1.99.0"})
	if err != nil || res.Error != g.NoSuchName || res.ErrorIndex != 2 {
		t.Fatalf("v1 GET of an absent object must fail noSuchName at index 2, got %+v %v", res, err)
	}
	names := walkNames(t, c, ".1.3.6.1.2.1.31", false)
	if len(names) != 0 {
		t.Fatalf("v1 must not expose Counter64 objects, walked %v", names)
	}
	if got := walkNames(t, c, ifDescr, false); len(got) != testRows {
		t.Fatalf("v1 GETNEXT walk returned %d rows", len(got))
	}
}

func TestCommunityIsChecked(t *testing.T) {
	a := listen(t, Config{Community: testCommunity, V2c: true})
	c := client(t, a, &g.GoSNMP{Version: g.Version2c, Community: "wrong", Timeout: shortTimeout})
	if _, err := c.Get([]string{sysName}); err == nil {
		t.Fatal("a wrong community must not be answered")
	}
	if a.Stats.BadCommunity.Load() == 0 {
		t.Fatal("bad community not counted")
	}
	v1 := client(t, a, &g.GoSNMP{Version: g.Version1, Community: testCommunity, Timeout: shortTimeout})
	if _, err := v1.Get([]string{sysName}); err == nil {
		t.Fatal("v1 must not be answered when only v2c is enabled")
	}
}

func TestUSMEveryProtocolPair(t *testing.T) {
	pairs := []struct {
		auth g.SnmpV3AuthProtocol
		priv g.SnmpV3PrivProtocol
	}{
		{g.MD5, g.DES}, {g.SHA, g.AES}, {g.SHA224, g.AES192}, {g.SHA256, g.AES256}, {g.SHA384, g.AES192C}, {g.SHA512, g.AES256C}, {g.SHA256, g.NoPriv}, {g.SHA, g.DES},
	}
	for _, p := range pairs {
		t.Run(p.auth.String()+"-"+p.priv.String(), func(t *testing.T) {
			user := &User{Name: "simuser", Auth: p.auth, AuthPassphrase: "auth-passphrase-1", Priv: p.priv, PrivPassphrase: "priv-passphrase-2"}
			a := listen(t, Config{User: user, EngineID: EngineID(9, []byte{0, 0x1b, 0x54, 1, 2, 3}), EngineBoots: 3, EngineTime: 1000})
			flags := g.AuthPriv
			if p.priv == g.NoPriv {
				flags = g.AuthNoPriv
			}
			c := client(t, a, &g.GoSNMP{Version: g.Version3, SecurityModel: g.UserSecurityModel, MsgFlags: flags, SecurityParameters: &g.UsmSecurityParameters{
				UserName: user.Name, AuthenticationProtocol: p.auth, AuthenticationPassphrase: user.AuthPassphrase, PrivacyProtocol: p.priv, PrivacyPassphrase: user.PrivPassphrase,
			}})
			res, err := c.Get([]string{sysName})
			if err != nil || string(res.Variables[0].Value.([]byte)) != "sim-01" {
				t.Fatalf("v3 GET failed: %+v %v", res, err)
			}
			if got := walkNames(t, c, ifDescr, true); len(got) != testRows {
				t.Fatalf("v3 bulk walk returned %d rows", len(got))
			}
			if a.Stats.UnknownEngineIDs.Load() != 1 {
				t.Fatalf("engine discovery should take exactly one report, took %d", a.Stats.UnknownEngineIDs.Load())
			}
			bad := client(t, a, &g.GoSNMP{Version: g.Version3, SecurityModel: g.UserSecurityModel, MsgFlags: flags, Timeout: shortTimeout, Retries: 0, SecurityParameters: &g.UsmSecurityParameters{
				UserName: user.Name, AuthenticationProtocol: p.auth, AuthenticationPassphrase: "not-the-passphrase", PrivacyProtocol: p.priv, PrivacyPassphrase: user.PrivPassphrase,
			}})
			if _, err := bad.Get([]string{sysName}); err == nil {
				t.Fatal("a wrong authentication passphrase must not be answered")
			}
			if a.Stats.WrongDigests.Load() == 0 {
				t.Fatal("wrong digest not reported")
			}
		})
	}
}

func TestUSMUnknownUserAndLevel(t *testing.T) {
	user := &User{Name: "simuser", Auth: g.SHA, AuthPassphrase: "auth-passphrase-1", Priv: g.AES, PrivPassphrase: "priv-passphrase-2"}
	a := listen(t, Config{User: user, EngineID: EngineID(30065, []byte{0x28, 0x99, 0x3a, 1, 2, 3}), EngineBoots: 1})
	other := client(t, a, &g.GoSNMP{Version: g.Version3, SecurityModel: g.UserSecurityModel, MsgFlags: g.AuthPriv, Timeout: shortTimeout, SecurityParameters: &g.UsmSecurityParameters{
		UserName: "intruder", AuthenticationProtocol: g.SHA, AuthenticationPassphrase: user.AuthPassphrase, PrivacyProtocol: g.AES, PrivacyPassphrase: user.PrivPassphrase,
	}})
	if _, err := other.Get([]string{sysName}); err == nil || a.Stats.UnknownUserNames.Load() == 0 {
		t.Fatalf("an unknown user must be refused with usmStatsUnknownUserNames: %v", err)
	}
	lower := client(t, a, &g.GoSNMP{Version: g.Version3, SecurityModel: g.UserSecurityModel, MsgFlags: g.AuthNoPriv, Timeout: shortTimeout, SecurityParameters: &g.UsmSecurityParameters{
		UserName: user.Name, AuthenticationProtocol: g.SHA, AuthenticationPassphrase: user.AuthPassphrase,
	}})
	if _, err := lower.Get([]string{sysName}); err == nil || a.Stats.UnsupportedSecLevels.Load() == 0 {
		t.Fatalf("authNoPriv for an authPriv user must be refused with usmStatsUnsupportedSecLevels: %v", err)
	}
}
