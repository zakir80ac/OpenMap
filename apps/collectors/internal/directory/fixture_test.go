// T-311 REQ-DISC-023 — recorded vendor fixtures: the LDAP conversation the collector's real Search
// held with OpenLDAP slapd 2.6.10 and a Samba 4.17 Active Directory domain controller in the container
// lab (packages/testing/fixtures/vendor/ldap). A loopback server reads each LDAPMessage the client
// sends and answers with the recorded server messages carrying the same message ID, so go-ldap, Search
// and Emit run over the vendor's bytes.
package directory

import (
	"context"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

const fxLDAPFamilyDir = "../../../../packages/testing/fixtures/vendor/ldap"

const (
	fxTagSequence   = 0x30
	fxTagInteger    = 0x02
	fxTagUnbind     = 0x42
	fxLongLengthBit = 0x80
)

type fxPrincipal struct {
	typ        string
	enabled    bool
	neverExp   bool
	groups     []string
	spns       int
	mail, name string
}

type fxLDAPExpect struct {
	bindUser    string
	baseDN      string
	domain      string
	users       int
	computers   int
	groups      int
	principals  map[string]fxPrincipal
	hosts       map[string]string // fqdn -> operatingSystem
	hostEnabled map[string]bool   // pre-staged computer accounts are created disabled until a join
	serviceOU   string
	serviceCIs  int
	userCIs     int
}

var fxLDAPFixtures = map[string]fxLDAPExpect{
	"openldap-slapd-2.6.10": {
		bindUser: "cn=admin,dc=lab,dc=openmap,dc=test", baseDN: "dc=lab,dc=openmap,dc=test", domain: "lab.openmap.test",
		users: 4, computers: 0, groups: 3, serviceOU: "OU=Service Accounts", serviceCIs: 2, userCIs: 2,
		principals: map[string]fxPrincipal{
			"aisha.rahman": {typ: typeUser, enabled: true, mail: "aisha.rahman@lab.openmap.test", name: "Aisha Rahman", groups: []string{}},
			"omar.haddad":  {typ: typeUser, enabled: true, mail: "omar.haddad@lab.openmap.test", name: "Omar Haddad", groups: []string{}},
			"svc-backup":   {typ: typeService, enabled: true, name: "svc-backup", groups: []string{}},
			"svc-monitor":  {typ: typeService, enabled: true, name: "svc-monitor", groups: []string{}},
		},
		hosts: map[string]string{},
	},
	"samba-ad-dc-4.17.12": {
		bindUser: "Administrator@lab.openmap.test", baseDN: "DC=lab,DC=openmap,DC=test", domain: "lab.openmap.test",
		users: 7, computers: 3, groups: 40, serviceOU: "OU=Service Accounts", serviceCIs: 3, userCIs: 4,
		principals: map[string]fxPrincipal{
			"aisha.rahman@lab.openmap.test":  {typ: typeUser, enabled: true, mail: "aisha.rahman@lab.openmap.test", name: "Aisha Rahman", groups: []string{"Domain Admins", "NetOps"}},
			"omar.haddad@lab.openmap.test":   {typ: typeUser, enabled: false, name: "Omar Haddad", groups: []string{"DBA"}},
			"svc-sql@lab.openmap.test":       {typ: typeService, enabled: true, name: "svc-sql", spns: 1, groups: []string{"DBA"}},
			"svc-backup@lab.openmap.test":    {typ: typeService, enabled: true, neverExp: true, name: "svc-backup", groups: []string{}},
			"administrator@lab.openmap.test": {typ: typeUser, enabled: true, name: "Administrator", groups: []string{"Domain Admins", "Schema Admins", "Enterprise Admins", "Group Policy Creator Owners", "Administrators"}},
			// krbtgt carries the kadmin/changepw SPN, so the SPN rule classifies it as a service account.
			"krbtgt@lab.openmap.test": {typ: typeService, enabled: false, name: "krbtgt", spns: 1},
		},
		hosts:       map[string]string{"dc01.lab.openmap.test": "Samba", "app01.lab.openmap.test": "", "wks042.lab.openmap.test": ""},
		hostEnabled: map[string]bool{"dc01.lab.openmap.test": true},
	},
}

// fxReadMessage reads one BER-encoded LDAPMessage (SEQUENCE with definite length).
func fxReadMessage(r io.Reader) ([]byte, error) {
	head := make([]byte, 2)
	if _, err := io.ReadFull(r, head); err != nil {
		return nil, err
	}
	if head[0] != fxTagSequence {
		return nil, fmt.Errorf("unexpected tag %#x", head[0])
	}
	length := int(head[1])
	if head[1]&fxLongLengthBit != 0 {
		n := int(head[1] &^ fxLongLengthBit)
		ext := make([]byte, n)
		if _, err := io.ReadFull(r, ext); err != nil {
			return nil, err
		}
		head = append(head, ext...)
		length = 0
		for _, b := range ext {
			length = length<<8 | int(b)
		}
	}
	body := make([]byte, length)
	if _, err := io.ReadFull(r, body); err != nil {
		return nil, err
	}
	return append(head, body...), nil
}

// fxMessageID returns the messageID and the protocolOp tag of one LDAPMessage.
func fxMessageID(msg []byte) (int, byte, error) {
	i := 2
	if msg[1]&fxLongLengthBit != 0 {
		i += int(msg[1] &^ fxLongLengthBit)
	}
	if msg[i] != fxTagInteger {
		return 0, 0, fmt.Errorf("messageID tag %#x", msg[i])
	}
	n := int(msg[i+1])
	id := 0
	for _, b := range msg[i+2 : i+2+n] {
		id = id<<8 | int(b)
	}
	return id, msg[i+2+n], nil
}

func fxSplitMessages(t *testing.T, stream []byte) map[int][][]byte {
	t.Helper()
	out := map[int][][]byte{}
	r := &fxByteReader{b: stream}
	for r.Len() > 0 {
		m, err := fxReadMessage(r)
		if err != nil {
			t.Fatalf("recorded stream: %v", err)
		}
		id, _, err := fxMessageID(m)
		if err != nil {
			t.Fatal(err)
		}
		out[id] = append(out[id], m)
	}
	return out
}

type fxByteReader struct{ b []byte }

func (r *fxByteReader) Len() int { return len(r.b) }
func (r *fxByteReader) Read(p []byte) (int, error) {
	if len(r.b) == 0 {
		return 0, io.EOF
	}
	n := copy(p, r.b)
	r.b = r.b[n:]
	return n, nil
}

// fxReplayLDAP answers each client request with the recorded responses for its message ID and
// reports the request op tags it saw.
func fxReplayLDAP(t *testing.T, recordedClient, recordedServer map[int][][]byte) (string, int, <-chan []byte) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	ops := make(chan []byte, 1)
	go func() {
		var seen []byte
		defer func() { ops <- seen }()
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		for {
			m, err := fxReadMessage(conn)
			if err != nil {
				return
			}
			id, op, err := fxMessageID(m)
			if err != nil || op == fxTagUnbind {
				return
			}
			seen = append(seen, op)
			if rec := recordedClient[id]; len(rec) != 1 {
				return
			} else if _, recOp, _ := fxMessageID(rec[0]); recOp != op {
				return
			}
			for _, resp := range recordedServer[id] {
				if _, err := conn.Write(resp); err != nil {
					return
				}
			}
		}
	}()
	host, port, _ := net.SplitHostPort(ln.Addr().String())
	p, _ := strconv.Atoi(port)
	return host, p, ops
}

func TestREQDISC023_T311_RecordedVendorFixtures(t *testing.T) {
	dirs, err := os.ReadDir(fxLDAPFamilyDir)
	if err != nil {
		t.Fatalf("fixture family dir: %v", err)
	}
	seen := 0
	for _, d := range dirs {
		if !d.IsDir() {
			continue
		}
		want, ok := fxLDAPFixtures[d.Name()]
		if !ok {
			t.Errorf("fixture %s has no expectation row", d.Name())
			continue
		}
		seen++
		dir := filepath.Join(fxLDAPFamilyDir, d.Name())
		t.Run(d.Name(), func(t *testing.T) {
			if _, err := os.Stat(filepath.Join(dir, "manifest.json")); err != nil {
				t.Fatalf("manifest: %v", err)
			}
			clientRaw, err := os.ReadFile(filepath.Join(dir, "ldap.client.ber"))
			if err != nil {
				t.Fatal(err)
			}
			serverRaw, err := os.ReadFile(filepath.Join(dir, "ldap.server.ber"))
			if err != nil {
				t.Fatal(err)
			}
			host, port, ops := fxReplayLDAP(t, fxSplitMessages(t, clientRaw), fxSplitMessages(t, serverRaw))
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			// The bind password was redacted in the recording; the replay accepts whatever is sent.
			inv, err := Search(ctx, host, port, false, false, nil, want.bindUser, "redacted", "", true)
			if err != nil {
				t.Fatalf("Search over recorded %s: %v", d.Name(), err)
			}
			if inv.BaseDN != want.baseDN || len(inv.Users) != want.users || len(inv.Computers) != want.computers || len(inv.Groups) != want.groups {
				t.Fatalf("inventory base=%q users=%d computers=%d groups=%d", inv.BaseDN, len(inv.Users), len(inv.Computers), len(inv.Groups))
			}
			obs := Emit(inv, contract.Target{Kind: "host", Value: "10.250.70.10"}, want.serviceOU, time.Now())
			byPrincipal := map[string]contract.ObservedCi{}
			hosts := map[string]contract.ObservedCi{}
			users, services := 0, 0
			for _, c := range obs.Cis {
				switch c.Type {
				case typeUser:
					users++
					byPrincipal[c.Identity["principalName"]] = c
				case typeService:
					services++
					byPrincipal[c.Identity["principalName"]] = c
				case typeHost:
					hosts[c.Identity["fqdn"]] = c
				}
				if c.Type != typeHost && c.Identity["directoryRef"] != toLower(want.baseDN) {
					t.Errorf("%s directoryRef %q", c.Name, c.Identity["directoryRef"])
				}
			}
			if users != want.userCIs || services != want.serviceCIs {
				t.Errorf("user_account=%d service_account=%d, want %d and %d", users, services, want.userCIs, want.serviceCIs)
			}
			for principal, p := range want.principals {
				c, ok := byPrincipal[principal]
				if !ok {
					t.Errorf("no CI for %s", principal)
					continue
				}
				a := c.Attributes
				if c.Type != p.typ || a["enabled"] != p.enabled || a["passwordNeverExpires"] != p.neverExp || c.Name != p.name || a["directory"] != want.domain {
					t.Errorf("%s: type=%s name=%q attrs=%v", principal, c.Type, c.Name, a)
				}
				if p.mail != "" && a["mail"] != p.mail {
					t.Errorf("%s mail %v", principal, a["mail"])
				}
				if spns, _ := a["servicePrincipalNames"].([]string); len(spns) != p.spns {
					t.Errorf("%s spns %v", principal, spns)
				}
				if p.groups != nil {
					got, _ := a["groups"].([]string)
					if len(got) != len(p.groups) {
						t.Errorf("%s groups %v, want %v", principal, got, p.groups)
					}
					for _, g := range p.groups {
						if !containsString(got, g) {
							t.Errorf("%s groups %v missing %s", principal, got, g)
						}
					}
				}
				if len(c.ExternalIDs) != 1 || c.ExternalIDs[0].Source != "ldap" || c.ExternalIDs[0].ID == "" {
					t.Errorf("%s external ids %v", principal, c.ExternalIDs)
				}
			}
			if len(hosts) != len(want.hosts) {
				t.Errorf("hosts %d, want %d", len(hosts), len(want.hosts))
			}
			for fqdn, osName := range want.hosts {
				h, ok := hosts[fqdn]
				if !ok {
					t.Errorf("no host CI %s", fqdn)
					continue
				}
				if h.Attributes["operatingSystem"] != osName || h.Attributes["directory"] != want.domain || h.Attributes["adEnabled"] != want.hostEnabled[fqdn] {
					t.Errorf("host %s attributes %v", fqdn, h.Attributes)
				}
			}
			if got := <-ops; len(got) < 4 {
				t.Errorf("collector sent %d requests before unbind", len(got))
			}
		})
	}
	if seen == 0 {
		t.Fatal("no recorded LDAP fixtures found")
	}
}

func toLower(s string) string {
	b := []byte(s)
	for i, c := range b {
		if c >= 'A' && c <= 'Z' {
			b[i] = c + ('a' - 'A')
		}
	}
	return string(b)
}

func containsString(list []string, v string) bool {
	for _, s := range list {
		if s == v {
			return true
		}
	}
	return false
}
