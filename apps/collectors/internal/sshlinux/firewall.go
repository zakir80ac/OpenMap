// REQ-IPAM-005 (ADR-064) — the host firewall from `nft -j list ruleset` (libnftables JSON schema 1): every rule of
// every chain in rule-set order with what it matches (addresses, services, interfaces, other conditions), what it
// does (verdict, jump target, NAT translation), its counter and log flag; a base chain's policy as a last rule; and the
// named sets rules reference (`@name`) as policy objects. iptables-nft rules appear in the same listing.
package sshlinux

import (
	"encoding/json"
	"sort"
	"strconv"
	"strings"
)

const (
	actionAllow    = "allow"
	actionDeny     = "deny"
	actionReject   = "reject"
	actionNat      = "nat"
	actionJump     = "jump"
	actionGoto     = "goto"
	actionReturn   = "return"
	actionContinue = "continue"

	objectAddress   = "address"
	objectService   = "service"
	objectInterface = "interface"
	objectOther     = "other"

	negationPrefix = "!"
	setReference   = "@"
	// anyProtocol is the service protocol of a transport-header port no protocol narrows ("*/53" matches tcp and udp).
	anyProtocol = "*"
)

// FirewallRule is one nftables rule (or a base chain's policy) as the collector reports it.
type FirewallRule struct {
	RuleID       string
	Family       string
	Table        string
	Chain        string // "<family> <table> <chain>", unique on the host
	Hook         string
	ChainType    string
	Position     int
	Handle       int
	Action       string
	Target       string
	Sources      []string
	Destinations []string
	Services     []string
	InInterface  string
	OutInterface string
	Conditions   []string
	Counted      bool
	Packets      int64
	Logging      bool
	Comment      string
	IsPolicy     bool
	ObjectRefs   []string // set names the rule references
}

// FirewallObject is one named nftables set.
type FirewallObject struct {
	ObjectID string
	Family   string
	Table    string
	Name     string
	Kind     string
	SetType  string
	Elements []string
	Flags    []string
	Comment  string
}

// Firewall is the parsed rule set; Readable is false when the listing was empty (no permission or no nft).
type Firewall struct {
	Readable bool
	Version  string
	Rules    []FirewallRule
	Objects  []FirewallObject
}

type nftChain struct {
	Family string `json:"family"`
	Table  string `json:"table"`
	Name   string `json:"name"`
	Handle int    `json:"handle"`
	Type   string `json:"type"`
	Hook   string `json:"hook"`
	Policy string `json:"policy"`
}

type nftSet struct {
	Family  string            `json:"family"`
	Table   string            `json:"table"`
	Name    string            `json:"name"`
	Type    json.RawMessage   `json:"type"`
	Flags   []string          `json:"flags"`
	Comment string            `json:"comment"`
	Elem    []json.RawMessage `json:"elem"`
}

type nftRule struct {
	Family  string                       `json:"family"`
	Table   string                       `json:"table"`
	Chain   string                       `json:"chain"`
	Handle  int                          `json:"handle"`
	Comment string                       `json:"comment"`
	Expr    []map[string]json.RawMessage `json:"expr"`
}

type nftMatch struct {
	Op    string                     `json:"op"`
	Left  map[string]json.RawMessage `json:"left"`
	Right json.RawMessage            `json:"right"`
}

func chainName(family, table, chain string) string {
	return family + " " + table + " " + chain
}

// ParseFirewall reads the nft JSON listing; empty or unparsable text gives an unreadable Firewall.
func ParseFirewall(text string) Firewall {
	text = strings.TrimSpace(text)
	if text == "" {
		return Firewall{}
	}
	var doc struct {
		Nftables []map[string]json.RawMessage `json:"nftables"`
	}
	if err := json.Unmarshal([]byte(text), &doc); err != nil {
		return Firewall{}
	}
	fw := Firewall{Readable: true}
	chains := map[string]nftChain{}
	var chainOrder []string
	positions := map[string]int{}
	for _, item := range doc.Nftables {
		if raw, ok := item["metainfo"]; ok {
			var meta struct {
				Version string `json:"version"`
			}
			if json.Unmarshal(raw, &meta) == nil {
				fw.Version = meta.Version
			}
		}
		if raw, ok := item["chain"]; ok {
			var c nftChain
			if json.Unmarshal(raw, &c) == nil {
				key := chainName(c.Family, c.Table, c.Name)
				chains[key] = c
				chainOrder = append(chainOrder, key)
			}
		}
		if raw, ok := item["set"]; ok {
			var s nftSet
			if json.Unmarshal(raw, &s) == nil {
				fw.Objects = append(fw.Objects, parseSet(s))
			}
		}
		if raw, ok := item["rule"]; ok {
			var r nftRule
			if json.Unmarshal(raw, &r) == nil {
				key := chainName(r.Family, r.Table, r.Chain)
				positions[key]++
				c := chains[key]
				fw.Rules = append(fw.Rules, parseRule(r, key, c, positions[key]))
			}
		}
	}
	for _, key := range chainOrder {
		c := chains[key]
		if c.Hook == "" || c.Policy == "" {
			continue
		}
		fw.Rules = append(fw.Rules, FirewallRule{
			RuleID: c.Family + "/" + c.Table + "/" + c.Name + "/policy", Family: c.Family, Table: c.Table, Chain: key, Hook: c.Hook, ChainType: c.Type,
			Position: positions[key] + 1, Action: verdictAction(c.Policy), IsPolicy: true, Comment: "",
		})
	}
	return fw
}

func verdictAction(word string) string {
	switch word {
	case "accept":
		return actionAllow
	case "drop":
		return actionDeny
	case "reject":
		return actionReject
	default:
		return actionContinue
	}
}

func parseSet(s nftSet) FirewallObject {
	o := FirewallObject{ObjectID: s.Family + "/" + s.Table + "/" + s.Name, Family: s.Family, Table: s.Table, Name: s.Name, Flags: s.Flags, Comment: s.Comment, Kind: objectOther}
	var single string
	if json.Unmarshal(s.Type, &single) == nil {
		o.SetType = single
		switch single {
		case "ipv4_addr", "ipv6_addr":
			o.Kind = objectAddress
		case "inet_service":
			o.Kind = objectService
		case "ifname":
			o.Kind = objectInterface
		}
	} else {
		var parts []string
		if json.Unmarshal(s.Type, &parts) == nil {
			o.SetType = strings.Join(parts, " . ")
		}
	}
	for _, e := range s.Elem {
		o.Elements = append(o.Elements, values(e)...)
	}
	return o
}

// values renders a JSON right-hand side or set element as plain specs: addresses, prefixes (a/len), ranges (a-b),
// numbers, names and set references (@name).
func values(raw json.RawMessage) []string {
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return []string{s}
	}
	var n json.Number
	if json.Unmarshal(raw, &n) == nil {
		return []string{n.String()}
	}
	var arr []json.RawMessage
	if json.Unmarshal(raw, &arr) == nil {
		var out []string
		for _, a := range arr {
			out = append(out, values(a)...)
		}
		return out
	}
	var obj map[string]json.RawMessage
	if json.Unmarshal(raw, &obj) != nil {
		return nil
	}
	if p, ok := obj["prefix"]; ok {
		var prefix struct {
			Addr string `json:"addr"`
			Len  int    `json:"len"`
		}
		if json.Unmarshal(p, &prefix) == nil {
			return []string{prefix.Addr + "/" + strconv.Itoa(prefix.Len)}
		}
	}
	if r, ok := obj["range"]; ok {
		var bounds []json.RawMessage
		if json.Unmarshal(r, &bounds) == nil && len(bounds) == 2 {
			lo, hi := values(bounds[0]), values(bounds[1])
			if len(lo) == 1 && len(hi) == 1 {
				return []string{lo[0] + "-" + hi[0]}
			}
		}
	}
	if set, ok := obj["set"]; ok {
		return values(set)
	}
	if elem, ok := obj["elem"]; ok {
		var e struct {
			Val json.RawMessage `json:"val"`
		}
		if json.Unmarshal(elem, &e) == nil {
			return values(e.Val)
		}
	}
	return nil
}

func withNegation(op string, vs []string) []string {
	if op != "!=" {
		return vs
	}
	out := make([]string, len(vs))
	for i, v := range vs {
		out[i] = negationPrefix + v
	}
	return out
}

func protocolWord(v string) string {
	switch v {
	case "1":
		return "icmp"
	case "6":
		return "tcp"
	case "17":
		return "udp"
	case "58":
		return "icmpv6"
	case "132":
		return "sctp"
	}
	return v
}

func parseRule(r nftRule, chain string, c nftChain, position int) FirewallRule {
	rule := FirewallRule{
		RuleID: r.Family + "/" + r.Table + "/" + r.Chain + "/" + strconv.Itoa(r.Handle), Family: r.Family, Table: r.Table, Chain: chain,
		Hook: c.Hook, ChainType: c.Type, Position: position, Handle: r.Handle, Comment: r.Comment, Action: actionContinue,
	}
	var protocols []string
	ports := map[string][]string{} // protocol -> port or type specs
	var protoOrder []string
	addPort := func(proto string, vs []string) {
		if _, seen := ports[proto]; !seen {
			protoOrder = append(protoOrder, proto)
		}
		ports[proto] = append(ports[proto], vs...)
	}
	for _, e := range r.Expr {
		for kind, raw := range e {
			switch kind {
			case "match":
				var m nftMatch
				if json.Unmarshal(raw, &m) != nil {
					continue
				}
				rule.applyMatch(m, &protocols, addPort)
			case "counter":
				var ctr struct {
					Packets int64 `json:"packets"`
				}
				if json.Unmarshal(raw, &ctr) == nil {
					rule.Counted, rule.Packets = true, ctr.Packets
				}
			case "log":
				rule.Logging = true
			case "limit":
				var l struct {
					Rate int    `json:"rate"`
					Per  string `json:"per"`
				}
				if json.Unmarshal(raw, &l) == nil {
					rule.Conditions = append(rule.Conditions, "limit rate "+strconv.Itoa(l.Rate)+"/"+l.Per)
				}
			case "accept", "drop", "reject":
				rule.Action = verdictAction(kind)
			case "jump", "goto":
				var t struct {
					Target string `json:"target"`
				}
				if json.Unmarshal(raw, &t) == nil {
					rule.Action, rule.Target = kind, chainName(r.Family, r.Table, t.Target)
				}
			case "return":
				rule.Action = actionReturn
			case "dnat", "snat", "redirect":
				var t struct {
					Addr json.RawMessage `json:"addr"`
					Port json.RawMessage `json:"port"`
				}
				target := kind
				if json.Unmarshal(raw, &t) == nil {
					if a := values(t.Addr); len(a) == 1 {
						target += " to " + a[0]
						if p := values(t.Port); len(p) == 1 {
							target += ":" + p[0]
						}
					} else if p := values(t.Port); len(p) == 1 {
						target += " to :" + p[0]
					}
				}
				rule.Action, rule.Target = actionNat, target
			case "masquerade":
				rule.Action, rule.Target = actionNat, kind
			}
		}
	}
	// A transport-header port applies to each protocol the rule names, or to any protocol when it names none.
	if anyPorts, ok := ports[anyProtocol]; ok && len(protocols) > 0 {
		for _, p := range protocols {
			addPort(p, anyPorts)
		}
		delete(ports, anyProtocol)
	}
	for _, proto := range protoOrder {
		for _, v := range ports[proto] {
			neg := strings.HasPrefix(v, negationPrefix)
			spec := proto + "/" + strings.TrimPrefix(v, negationPrefix)
			if neg {
				spec = negationPrefix + spec
			}
			rule.Services = append(rule.Services, spec)
		}
	}
	for _, p := range protocols {
		if _, hasPorts := ports[p]; !hasPorts {
			rule.Services = append(rule.Services, p)
		}
	}
	for _, list := range [][]string{rule.Sources, rule.Destinations, rule.Services} {
		for _, v := range list {
			if i := strings.Index(v, setReference); i >= 0 {
				rule.ObjectRefs = append(rule.ObjectRefs, v[i+len(setReference):])
			}
		}
	}
	return rule
}

func (rule *FirewallRule) applyMatch(m nftMatch, protocols *[]string, addPort func(string, []string)) {
	right := values(m.Right)
	// Equality, set membership and its negation are modelled; any other operator (<, >, &) stays a condition.
	simple := m.Op == "==" || m.Op == "in" || m.Op == "!="
	if raw, ok := m.Left["payload"]; ok {
		var p struct {
			Protocol string `json:"protocol"`
			Field    string `json:"field"`
		}
		if json.Unmarshal(raw, &p) == nil {
			switch {
			case !simple:
			case (p.Protocol == "ip" || p.Protocol == "ip6") && p.Field == "saddr":
				rule.Sources = append(rule.Sources, withNegation(m.Op, right)...)
				return
			case (p.Protocol == "ip" || p.Protocol == "ip6") && p.Field == "daddr":
				rule.Destinations = append(rule.Destinations, withNegation(m.Op, right)...)
				return
			case (p.Protocol == "ip" && p.Field == "protocol") || (p.Protocol == "ip6" && p.Field == "nexthdr"):
				if m.Op != "!=" {
					for _, v := range right {
						*protocols = append(*protocols, protocolWord(v))
					}
					return
				}
			case p.Field == "dport" && p.Protocol == "th":
				// Transport header: the port of whichever protocol the rule names (meta l4proto), or of any.
				addPort(anyProtocol, withNegation(m.Op, right))
				return
			case p.Field == "dport":
				addPort(p.Protocol, withNegation(m.Op, right))
				return
			case (p.Protocol == "icmp" || p.Protocol == "icmpv6") && p.Field == "type":
				addPort(p.Protocol, withNegation(m.Op, right))
				return
			}
			rule.Conditions = append(rule.Conditions, condition(p.Protocol+" "+p.Field, m.Op, right))
			return
		}
	}
	if raw, ok := m.Left["meta"]; ok {
		var meta struct {
			Key string `json:"key"`
		}
		if json.Unmarshal(raw, &meta) == nil {
			switch {
			case !simple:
			case (meta.Key == "iifname" || meta.Key == "iif") && m.Op != "!=" && len(right) == 1:
				rule.InInterface = right[0]
				return
			case (meta.Key == "oifname" || meta.Key == "oif") && m.Op != "!=" && len(right) == 1:
				rule.OutInterface = right[0]
				return
			case meta.Key == "l4proto" && m.Op != "!=":
				for _, v := range right {
					*protocols = append(*protocols, protocolWord(v))
				}
				return
			}
			rule.Conditions = append(rule.Conditions, condition("meta "+meta.Key, m.Op, right))
			return
		}
	}
	if raw, ok := m.Left["ct"]; ok {
		var ct struct {
			Key string `json:"key"`
		}
		if json.Unmarshal(raw, &ct) == nil {
			rule.Conditions = append(rule.Conditions, condition("ct "+ct.Key, m.Op, right))
			return
		}
	}
	keys := make([]string, 0, len(m.Left))
	for k := range m.Left {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	rule.Conditions = append(rule.Conditions, condition(strings.Join(keys, " "), m.Op, right))
}

// condition words a match the read model does not evaluate, as nft would print it: "ct state established,related".
func condition(left, op string, right []string) string {
	value := strings.Join(right, ",")
	if op == "!=" {
		value = negationPrefix + value
	} else if op != "==" && op != "in" {
		return left + " " + op + " " + value
	}
	return left + " " + value
}

// Attributes are the `firewall_rule` CI attributes; the shape packages/contracts/src/firewall.ts reads.
func (rule FirewallRule) Attributes() map[string]any {
	attrs := map[string]any{
		"ruleId": rule.RuleID, "name": rule.DisplayName(), "family": rule.Family, "table": rule.Family + " " + rule.Table, "chain": rule.Chain,
		"position": rule.Position, "action": rule.Action, "enabled": true, "logging": rule.Logging, "isPolicy": rule.IsPolicy,
		"source": nonNil(rule.Sources), "destination": nonNil(rule.Destinations), "service": nonNil(rule.Services), "conditions": nonNil(rule.Conditions),
	}
	optional := map[string]string{"hook": rule.Hook, "chainType": rule.ChainType, "target": rule.Target, "inInterface": rule.InInterface, "outInterface": rule.OutInterface, "comment": rule.Comment}
	for k, v := range optional {
		if v != "" {
			attrs[k] = v
		}
	}
	if rule.Handle > 0 {
		attrs["handle"] = rule.Handle
	}
	if rule.Counted {
		attrs["hitCount"] = rule.Packets
	}
	return attrs
}

// DisplayName is the rule's comment, or its chain and position ("inet filter input #3", "inet filter input policy").
func (rule FirewallRule) DisplayName() string {
	if rule.Comment != "" {
		return rule.Comment
	}
	if rule.IsPolicy {
		return rule.Chain + " policy"
	}
	return rule.Chain + " #" + strconv.Itoa(rule.Position)
}

// Attributes are the `firewall_object` CI attributes.
func (o FirewallObject) Attributes() map[string]any {
	attrs := map[string]any{
		"objectId": o.ObjectID, "name": o.Name, "kind": o.Kind, "family": o.Family, "table": o.Family + " " + o.Table,
		"setType": o.SetType, "elements": nonNil(o.Elements), "flags": nonNil(o.Flags),
	}
	if o.Comment != "" {
		attrs["comment"] = o.Comment
	}
	return attrs
}

func nonNil(v []string) []string {
	if v == nil {
		return []string{}
	}
	return v
}
