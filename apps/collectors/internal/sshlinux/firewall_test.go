// T-558 REQ-IPAM-005 (ADR-064) — the host firewall parsed from the recorded nftables capture
// (fixtures/vendor/ssh_agentless/debian-debian-12-nftables): rules in chain order with what they match and do, base
// chain policies as last rules, named sets as policy objects, and the emitted CIs and links. Constructs the lab rule
// set does not use (transport-header ports, negation, goto, SNAT, comparison operators) are checked on nft JSON in the
// shape libnftables prints.
package sshlinux

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

func recordedFirewall(t *testing.T) (Firewall, []byte) {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(fixtureRoot, "debian-debian-12-nftables", "transcript.txt"))
	if err != nil {
		t.Fatal(err)
	}
	return ParseFirewall(Split(string(raw))["nft"]), raw
}

func ruleByID(fw Firewall, id string) FirewallRule {
	for _, r := range fw.Rules {
		if r.RuleID == id {
			return r
		}
	}
	return FirewallRule{}
}

func TestREQIPAM005_T558_RecordedRuleSet(t *testing.T) {
	fw, _ := recordedFirewall(t)
	if !fw.Readable || fw.Version != "1.0.6" || len(fw.Rules) != 21 || len(fw.Objects) != 3 {
		t.Fatalf("rule set: readable=%v version=%q rules=%d objects=%d", fw.Readable, fw.Version, len(fw.Rules), len(fw.Objects))
	}
	ssh := ruleByID(fw, "inet/filter/input/13")
	if ssh.Chain != "inet filter input" || ssh.Hook != "input" || ssh.ChainType != "filter" || ssh.Position != 5 || ssh.Action != actionAllow ||
		!reflect.DeepEqual(ssh.Sources, []string{"@admin_nets"}) || !reflect.DeepEqual(ssh.Services, []string{"tcp/22"}) ||
		!ssh.Counted || ssh.Packets != 1 || ssh.Comment != "ssh from admin networks" || !reflect.DeepEqual(ssh.ObjectRefs, []string{"admin_nets"}) {
		t.Errorf("ssh rule %+v", ssh)
	}
	icmp := ruleByID(fw, "inet/filter/input/12")
	if !reflect.DeepEqual(icmp.Services, []string{"icmp/destination-unreachable", "icmp/echo-request", "icmp/time-exceeded"}) || !reflect.DeepEqual(icmp.Conditions, []string{"limit rate 10/second"}) || icmp.Counted {
		t.Errorf("icmp rule %+v", icmp)
	}
	pg := ruleByID(fw, "inet/filter/input/17")
	if !reflect.DeepEqual(pg.Sources, []string{"10.40.0.0/16"}) || !reflect.DeepEqual(pg.Services, []string{"tcp/5432", "tcp/6432"}) {
		t.Errorf("postgres rule %+v", pg)
	}
	if r := ruleByID(fw, "inet/filter/input/18"); r.Action != actionReject || !reflect.DeepEqual(r.Services, []string{"tcp/3306"}) {
		t.Errorf("mysql rule %+v", r)
	}
	if r := ruleByID(fw, "inet/filter/input/19"); r.Action != actionDeny || !r.Logging || !r.Counted || len(r.Sources)+len(r.Services) != 0 || r.Position != 10 {
		t.Errorf("final drop %+v", r)
	}
	if r := ruleByID(fw, "inet/filter/input/8"); !reflect.DeepEqual(r.Conditions, []string{"ct state established,related"}) || r.Action != actionAllow {
		t.Errorf("established rule %+v", r)
	}
	if r := ruleByID(fw, "inet/filter/input/10"); r.InInterface != "lo" || r.Action != actionAllow {
		t.Errorf("loopback rule %+v", r)
	}
	if r := ruleByID(fw, "inet/filter/input/policy"); !r.IsPolicy || r.Action != actionDeny || r.Position != 11 {
		t.Errorf("input policy %+v", r)
	}
	if r := ruleByID(fw, "inet/filter/forward/21"); r.Action != actionJump || r.Target != "inet filter docker_user" {
		t.Errorf("jump %+v", r)
	}
	if r := ruleByID(fw, "inet/filter/docker_user/23"); r.Action != actionReturn || r.Hook != "" {
		t.Errorf("return %+v", r)
	}
	if r := ruleByID(fw, "inet/filter/output/policy"); r.Action != actionAllow {
		t.Errorf("output policy %+v", r)
	}
	if r := ruleByID(fw, "ip/nat/prerouting/3"); r.Action != actionNat || r.Target != "dnat to 10.88.0.10:80" || r.ChainType != "nat" || !reflect.DeepEqual(r.Services, []string{"tcp/8080"}) {
		t.Errorf("dnat %+v", r)
	}
	if r := ruleByID(fw, "ip/nat/postrouting/4"); r.Action != actionNat || r.Target != "masquerade" || r.OutInterface != "eth0" || !reflect.DeepEqual(r.Sources, []string{"10.88.0.0/16"}) {
		t.Errorf("masquerade %+v", r)
	}
	admin := fw.Objects[0]
	if admin.ObjectID != "inet/filter/admin_nets" || admin.Kind != objectAddress || !reflect.DeepEqual(admin.Elements, []string{"10.20.0.0/16", "172.16.0.0/12", "192.168.0.0/16"}) ||
		!reflect.DeepEqual(admin.Flags, []string{"interval"}) || admin.Comment != "Jump hosts, the admin VPN and the lab network" {
		t.Errorf("admin set %+v", admin)
	}
	if web := fw.Objects[1]; web.Kind != objectService || !reflect.DeepEqual(web.Elements, []string{"80", "443", "8443"}) {
		t.Errorf("web set %+v", web)
	}
}

func TestREQIPAM005_T558_EmittedFirewallCis(t *testing.T) {
	_, raw := recordedFirewall(t)
	f := Assemble(Split(string(raw)))
	obs := Emit(f, contract.Target{Kind: "host", Value: "127.0.0.1"}, raw, time.Date(2026, 11, 10, 11, 12, 0, 0, time.UTC))
	host := obs.Cis[0]
	if host.Attributes["firewall"] != "nftables" || host.Attributes["firewallRuleCount"] != 21 {
		t.Errorf("host firewall attributes %v", host.Attributes)
	}
	var rule, set *contract.ObservedCi
	for i := range obs.Cis {
		c := &obs.Cis[i]
		if c.Type == typeFwRule && c.Identity["ruleId"] == "inet/filter/input/13" {
			rule = c
		}
		if c.Type == typeFwObject && c.Identity["objectId"] == "inet/filter/admin_nets" {
			set = c
		}
	}
	if rule == nil || set == nil {
		t.Fatal("rule or set CI missing")
	}
	if rule.Identity["deviceRef"] != "lab-fw-debian12" || rule.Name != "lab-fw-debian12 ssh from admin networks" || rule.Attributes["hitCount"] != int64(1) ||
		rule.Attributes["table"] != "inet filter" || rule.Attributes["chain"] != "inet filter input" || rule.Attributes["hook"] != "input" {
		t.Errorf("rule CI %+v", rule)
	}
	if _, counted := ruleCi(obs.Cis, "inet/filter/input/12").Attributes["hitCount"]; counted {
		t.Error("a rule without a counter must not report a hit count")
	}
	if set.Identity["deviceRef"] != "lab-fw-debian12" || set.Attributes["kind"] != "address" {
		t.Errorf("set CI %+v", set)
	}
	links := 0
	for _, r := range obs.Relationships {
		if r.Type == relReferences && r.From.Identity["ruleId"] == "inet/filter/input/13" && r.To.Identity["objectId"] == "inet/filter/admin_nets" {
			links++
		}
	}
	if links != 1 {
		t.Errorf("ssh rule references admin_nets: %d links", links)
	}
}

func ruleCi(cis []contract.ObservedCi, id string) contract.ObservedCi {
	for _, c := range cis {
		if c.Type == typeFwRule && c.Identity["ruleId"] == id {
			return c
		}
	}
	return contract.ObservedCi{}
}

func TestREQIPAM005_T558_OtherExpressions(t *testing.T) {
	listing := `{"nftables": [{"metainfo": {"version": "1.0.9", "json_schema_version": 1}},
{"table": {"family": "inet", "name": "fw", "handle": 1}},
{"set": {"family": "inet", "name": "pairs", "table": "fw", "type": ["ipv4_addr", "inet_service"], "handle": 2, "elem": [{"concat": ["10.0.0.1", 53]}]}},
{"chain": {"family": "inet", "table": "fw", "name": "in", "handle": 3, "type": "filter", "hook": "input", "prio": 0, "policy": "accept"}},
{"chain": {"family": "inet", "table": "fw", "name": "side", "handle": 4}},
{"rule": {"family": "inet", "table": "fw", "chain": "in", "handle": 5, "expr": [{"match": {"op": "==", "left": {"meta": {"key": "l4proto"}}, "right": {"set": ["tcp", "udp"]}}}, {"match": {"op": "==", "left": {"payload": {"protocol": "th", "field": "dport"}}, "right": 53}}, {"accept": null}]}},
{"rule": {"family": "inet", "table": "fw", "chain": "in", "handle": 6, "expr": [{"match": {"op": "!=", "left": {"payload": {"protocol": "ip", "field": "saddr"}}, "right": {"prefix": {"addr": "10.0.0.0", "len": 8}}}}, {"match": {"op": "==", "left": {"payload": {"protocol": "tcp", "field": "dport"}}, "right": {"range": [8000, 8099]}}}, {"drop": null}]}},
{"rule": {"family": "inet", "table": "fw", "chain": "in", "handle": 7, "expr": [{"match": {"op": "<", "left": {"payload": {"protocol": "tcp", "field": "sport"}}, "right": 1024}}, {"goto": {"target": "side"}}]}},
{"rule": {"family": "inet", "table": "fw", "chain": "side", "handle": 8, "expr": [{"match": {"op": "==", "left": {"meta": {"key": "mark"}}, "right": 42}}, {"snat": {"addr": "192.0.2.1"}}]}}
]}`
	fw := ParseFirewall(listing)
	if len(fw.Rules) != 5 || len(fw.Objects) != 1 {
		t.Fatalf("rules %d objects %d", len(fw.Rules), len(fw.Objects))
	}
	if r := ruleByID(fw, "inet/fw/in/5"); !reflect.DeepEqual(r.Services, []string{"tcp/53", "udp/53"}) {
		t.Errorf("transport-header port %+v", r.Services)
	}
	if r := ruleByID(fw, "inet/fw/in/6"); !reflect.DeepEqual(r.Sources, []string{"!10.0.0.0/8"}) || !reflect.DeepEqual(r.Services, []string{"tcp/8000-8099"}) || r.Action != actionDeny {
		t.Errorf("negated source and port range %+v", r)
	}
	if r := ruleByID(fw, "inet/fw/in/7"); r.Action != actionGoto || r.Target != "inet fw side" || !reflect.DeepEqual(r.Conditions, []string{"tcp sport < 1024"}) {
		t.Errorf("goto with a comparison %+v", r)
	}
	if r := ruleByID(fw, "inet/fw/side/8"); r.Action != actionNat || r.Target != "snat to 192.0.2.1" || !reflect.DeepEqual(r.Conditions, []string{"meta mark 42"}) {
		t.Errorf("snat on a mark %+v", r)
	}
	if o := fw.Objects[0]; o.Kind != objectOther || o.SetType != "ipv4_addr . inet_service" {
		t.Errorf("concatenated set %+v", o)
	}
	if empty := ParseFirewall(""); empty.Readable || len(empty.Rules) != 0 {
		t.Errorf("an empty listing is unreadable, not an empty rule set: %+v", empty)
	}
}
