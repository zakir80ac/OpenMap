// T-048 REQ-DISC-022 — parses Windows DHCP JSON, ISC dhcpd.conf/dhcpd.leases and Kea config/CSV
// samples in their documented formats and checks scope, lease, address and leased_to emission.
package dhcp

import (
	"testing"
	"time"
)

const windowsSample = `{"scopes":[{"ScopeId":{"IPAddressToString":"10.20.30.0"},"SubnetMask":{"IPAddressToString":"255.255.255.0"},"Name":"Office VLAN 30","StartRange":{"IPAddressToString":"10.20.30.100"},"EndRange":{"IPAddressToString":"10.20.30.200"},"LeaseDuration":{"TotalSeconds":691200},"State":"Active"}],
"leases":[{"IPAddress":{"IPAddressToString":"10.20.30.101"},"ClientId":"3c-2c-30-aa-bb-01","HostName":"lt-ryd-0142.corp.example","LeaseExpiryTime":"/Date(1730000000000)/","AddressState":"Active","ScopeId":{"IPAddressToString":"10.20.30.0"}},
{"IPAddress":{"IPAddressToString":"10.20.30.150"},"ClientId":"b4-2e-99-aa-bb-02","HostName":"printer-3f","LeaseExpiryTime":null,"AddressState":"ActiveReservation","ScopeId":{"IPAddressToString":"10.20.30.0"}}],"options":[]}`

const iscConf = `
default-lease-time 600;
subnet 10.40.1.0 netmask 255.255.255.0 {
  range 10.40.1.50 10.40.1.250;
  option routers 10.40.1.1;
  option domain-name-servers 10.0.0.53, 10.0.0.54;  # corp resolvers
}
`

const iscLeases = `
lease 10.40.1.51 {
  starts 3 2026/10/22 06:00:00;
  ends 3 2026/10/22 06:10:00;
  binding state active;
  hardware ethernet 00:50:56:aa:bb:51;
  client-hostname "vm-lab-51";
}
lease 10.40.1.52 {
  binding state free;
  hardware ethernet 00:50:56:aa:bb:52;
}
lease 10.40.1.51 {
  ends 3 2026/10/22 06:20:00;
  binding state active;
  hardware ethernet 00:50:56:aa:bb:51;
  client-hostname "vm-lab-51-renamed";
}
`

const keaConf = `{
// Kea DHCPv4
"Dhcp4": {
  "valid-lifetime": 4000,
  "subnet4": [ { "subnet": "10.50.2.0/24", "pools": [ { "pool": "10.50.2.10 - 10.50.2.200" } ], "option-data": [ { "name": "routers", "data": "10.50.2.1" } ] } ]
}
}`

const keaCsv = `address,hwaddr,client_id,valid_lifetime,expire,subnet_id,fqdn_fwd,fqdn_rev,hostname,state,user_context,relay_id,remote_id,pool_id
10.50.2.11,52:54:00:aa:bb:11,01:52:54:00:aa:bb:11,4000,1760000000,1,0,0,kea-client-11,0,,,,0
10.50.2.12,52:54:00:aa:bb:12,,4000,1760000000,1,0,0,,1,,,,0
`

func TestWindows(t *testing.T) {
	scopes, leases, err := ParseWindows("banner\n" + windowsSample)
	if err != nil {
		t.Fatal(err)
	}
	if len(scopes) != 1 || scopes[0].CIDR != "10.20.30.0/24" || scopes[0].LeaseTTL != "691200" {
		t.Fatalf("scopes wrong: %+v", scopes)
	}
	if len(leases) != 2 || leases[0].MAC != "3c:2c:30:aa:bb:01" || !leases[1].Static || leases[1].ScopeCIDR != "10.20.30.0/24" {
		t.Fatalf("leases wrong: %+v", leases)
	}
	obs := Emit("dhcp-ryd-01.corp.example", scopes, leases, []byte(windowsSample), time.Now())
	types := map[string]int{}
	rels := map[string]int{}
	for _, c := range obs.Cis {
		types[c.Type]++
	}
	for _, r := range obs.Relationships {
		rels[r.Type]++
		if r.Type == relLeasedTo && r.To.Identity["primaryMac"] == "3c:2c:30:aa:bb:01" && r.To.Identity["fqdn"] != "lt-ryd-0142.corp.example" {
			t.Fatalf("leased_to host identity wrong: %+v", r.To)
		}
	}
	if types[typeScope] != 1 || types[typeLease] != 2 || types[typeIP] != 2 || rels[relContains] != 2 || rels[relLeasedTo] != 2 || rels[relInSubnet] != 1 {
		t.Fatalf("emission wrong: %+v %+v", types, rels)
	}
	if obs.Cis[0].Attributes["poolSize"] != 101 || obs.Cis[0].Attributes["activeLeases"] != 2 {
		t.Fatalf("scope attributes wrong: %+v", obs.Cis[0].Attributes)
	}
}

func TestIsc(t *testing.T) {
	scopes := ParseIscConfig(iscConf)
	if len(scopes) != 1 || scopes[0].CIDR != "10.40.1.0/24" || scopes[0].Router != "10.40.1.1" || len(scopes[0].DNS) != 2 || scopes[0].End != "10.40.1.250" {
		t.Fatalf("isc scopes wrong: %+v", scopes)
	}
	leases := ParseIscLeases(iscLeases, scopes)
	if len(leases) != 1 || leases[0].Hostname != "vm-lab-51-renamed" || leases[0].MAC != "00:50:56:aa:bb:51" || leases[0].ScopeCIDR != "10.40.1.0/24" {
		t.Fatalf("isc leases wrong: %+v", leases)
	}
}

func TestKea(t *testing.T) {
	scopes := ParseKeaConfig(keaConf)
	if len(scopes) != 1 || scopes[0].Start != "10.50.2.10" || scopes[0].End != "10.50.2.200" || scopes[0].Router != "10.50.2.1" || scopes[0].LeaseTTL != "4000" {
		t.Fatalf("kea scopes wrong: %+v", scopes)
	}
	leases := ParseKeaLeases(keaCsv, scopes)
	if len(leases) != 1 || leases[0].Address != "10.50.2.11" || leases[0].Hostname != "kea-client-11" {
		t.Fatalf("kea leases wrong: %+v", leases)
	}
}
