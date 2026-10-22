// T-054 REQ-DISC-023 — emission from AD-shaped entries: UPN identity, UAC flags, FILETIME conversion,
// service-account classification by SPN and OU, and computer objects as hosts.
package directory

import (
	"testing"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

func entry(dn string, attrs map[string]string, multi map[string][]string, object string) Entry {
	if multi == nil {
		multi = map[string][]string{}
	}
	return Entry{DN: dn, Attrs: attrs, Multi: multi, Object: object}
}

func TestEmit(t *testing.T) {
	inv := &Inventory{BaseDN: "DC=corp,DC=example", Raw: []byte("x"),
		Users: []Entry{
			entry("CN=Sara Ahmed,OU=Users,DC=corp,DC=example", map[string]string{"sAMAccountName": "sahmed", "userPrincipalName": "sahmed@corp.example", "displayName": "Sara Ahmed", "mail": "Sara.Ahmed@corp.example", "userAccountControl": "512", "lastLogonTimestamp": "133700000000000000", "pwdLastSet": "133600000000000000"}, map[string][]string{"memberOf": {"CN=Domain Users,CN=Users,DC=corp,DC=example", "CN=DBA,OU=Groups,DC=corp,DC=example"}}, "user"),
			entry("CN=svc-sql,OU=Service Accounts,DC=corp,DC=example", map[string]string{"sAMAccountName": "svc-sql", "userAccountControl": "66048"}, map[string][]string{"servicePrincipalName": {"MSSQLSvc/sql-ryd-01.corp.example:1433"}}, "user"),
			entry("CN=old,OU=Users,DC=corp,DC=example", map[string]string{"sAMAccountName": "old", "userAccountControl": "514"}, nil, "user"),
		},
		Computers: []Entry{entry("CN=SQL-RYD-01,OU=Servers,DC=corp,DC=example", map[string]string{"dNSHostName": "SQL-RYD-01.corp.example", "sAMAccountName": "SQL-RYD-01$", "operatingSystem": "Windows Server 2022 Datacenter", "operatingSystemVersion": "10.0 (20348)", "userAccountControl": "4096"}, nil, "computer")},
	}
	obs := Emit(inv, contract.Target{Kind: "host", Value: "dc01.corp.example"}, "OU=Service Accounts", time.Now())
	types := map[string]int{}
	for _, c := range obs.Cis {
		types[c.Type]++
	}
	if types[typeUser] != 2 || types[typeService] != 1 || types[typeHost] != 1 {
		t.Fatalf("unexpected CI mix: %+v", types)
	}
	sara := obs.Cis[0]
	if sara.Identity["principalName"] != "sahmed@corp.example" || sara.Identity["directoryRef"] != "dc=corp,dc=example" || sara.Attributes["enabled"] != true || sara.Attributes["mail"] != "sara.ahmed@corp.example" {
		t.Fatalf("user wrong: %+v", sara)
	}
	groups, _ := sara.Attributes["groups"].([]string)
	if len(groups) != 2 || groups[1] != "DBA" {
		t.Fatalf("groups wrong: %+v", groups)
	}
	if sara.Attributes["lastLogon"] != "2024-09-05T08:53:20Z" {
		t.Fatalf("filetime wrong: %v", sara.Attributes["lastLogon"])
	}
	svc := obs.Cis[1]
	if svc.Type != typeService || svc.Identity["principalName"] != "svc-sql@corp.example" || svc.Attributes["passwordNeverExpires"] != true {
		t.Fatalf("service account wrong: %+v", svc)
	}
	if obs.Cis[2].Attributes["enabled"] != false {
		t.Fatalf("disabled flag wrong: %+v", obs.Cis[2].Attributes)
	}
	host := obs.Cis[3]
	if host.Type != typeHost || host.Identity["fqdn"] != "sql-ryd-01.corp.example" || host.Attributes["operatingSystem"] != "Windows Server 2022 Datacenter" {
		t.Fatalf("computer wrong: %+v", host)
	}
}

func TestHelpers(t *testing.T) {
	if DomainOf("CN=x,OU=y,DC=Corp,DC=Example") != "corp.example" {
		t.Fatal("DomainOf failed")
	}
	if Filetime("0") != "" || Filetime("") != "" {
		t.Fatal("Filetime should treat unset values as empty")
	}
	if !IsServiceAccount(entry("CN=a,OU=Service Accounts,DC=c", map[string]string{}, nil, "user"), "ou=service accounts") {
		t.Fatal("OU classification failed")
	}
}
