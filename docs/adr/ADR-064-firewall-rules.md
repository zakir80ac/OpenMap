# ADR-064 — Firewall rules and policy objects: discovery, analysis and the traffic check

Status: Accepted · Date: 2026-11-10 · Tracker: REQ-IPAM-005 · Contracts: CI 0.10.0, collector 0.10.0, GraphQL 1.37.0

## Context

CAPABILITY-MAP.md §5 lists "firewall rules and policy objects" as an IPAM capability (`firewall_rule` CI). The CI type
existed and the synthetic estate filled it with eight zone-based rules per firewall, but no collector emitted rules, no
policy object had a home, and nothing read them. Firewall appliance APIs (PAN-OS, FortiOS, ASA) need vendor access,
which was deferred on 2026-11-09, so recorded captures of them cannot be made yet. Every Linux server has a firewall
of its own, though: nftables (and iptables-nft, which lists through the same interface), readable over the SSH session
the agentless collector already opens, and capturable from a lab container.

## Decision

1. **The SSH collector reads the host firewall.** `Script()` gains `sudo -n nft -j list ruleset` with a fallback to
   plain `nft` and to nothing. Listing a rule set needs CAP_NET_ADMIN, so a site that wants host rules grants exactly
   that command in sudoers (`<user> ALL=(root) NOPASSWD: /usr/sbin/nft -j list ruleset`); the collector never needs
   root and carries on without it. Empty output means "not readable", not "no rules": the host then reports no
   firewall attributes at all.
2. **Rules keep evaluation order and chains.** Each rule is a `firewall_rule` CI keyed by the host and
   `<family>/<table>/<chain>/<handle>`, with its chain (`<family> <table> <chain>`), hook, chain type, position, what it
   matches (source and destination addresses and prefixes, `!` for negation, `@set` references; services as
   `proto/port`, ranges, `proto/@set`, ICMP types; in and out interfaces; other match expressions as conditions such as
   `ct state established,related` or `limit rate 10/second`), what it does (`allow`, `deny`, `reject`, `nat` with the
   translation, `jump`/`goto` with the target chain, `return`, `continue`), its packet counter as `hitCount` and its log
   flag. A base chain's policy is a last rule of its chain with `isPolicy`. Zone-based firewalls fit the same shape
   with one ordered list (chain `''`) and `fromZone`/`toZone`.
3. **Policy objects are CIs of their own.** A new CI type, `firewall_object`, keyed by device and `objectId`, holds
   an address group, service group or nftables set with its kind and members. The device contains it and every rule
   that names it `depends_on` it, so the graph answers "which rules use this group".
4. **Matching, evaluation and analysis live in the contract** (`packages/contracts/src/firewall.ts`), shared by the API,
   the console and the tests. Addresses are compared as numbers (IPv4 and IPv6, prefixes, ranges), groups are expanded
   to `FIREWALL.maxObjectDepth`, jumps and gotos followed to `FIREWALL.maxJumpDepth`. A traffic check evaluates the
   first packet of a new connection per entry chain (base filter chains, or the single list): a rule whose match the
   packet cannot settle (a zone or interface not given, an unknown condition) is listed as uncertain and passed over;
   connection-state conditions are judged for a new connection, rate limits as matching.
5. **The analysis names three kinds of rule and one of object.** _Shadowed_: an earlier terminal rule without
   conditions, in the same chain and zones or interfaces, matches everything this rule does (sources and destinations
   contained, prefixes merged; services contained), so it can never match; the finding says whether the earlier rule
   does the same (redundant) or the opposite (conflict). _Unused_: the counter says zero. _Permissive_: an allow for any
   service from or to anywhere, not narrowed by an interface or condition. _Unused objects_: groups no rule names,
   directly or through another group. The analysis is quadratic per chain and stops at `FIREWALL.analysisRuleLimit`.
6. **Reads, not writes.** OpenMap reports and analyses; it does not change a firewall. Queries `firewallDevices`,
   `firewallPolicy`, `firewallCheck`; metric `openmap_firewall_reads_total{query}`; spans `ipam.firewall.*`.

## Consequences

- CI 0.10.0 and collector 0.10.0 (the new CI type; Go `contract.Version` follows), Prisma migration 0043, Memgraph
  `0003_firewall_object` label index; GraphQL 1.37.0 (additive).
- The IPAM screen gains a **Firewall** tab: device choice, the traffic check, seven totals, chains with policies, the
  rule table with findings and a findings-only filter, and the policy objects.
- The SSH fixture set gains a recorded capture of a Debian 12 host with nftables
  (`fixtures/vendor/ssh_agentless/debian-debian-12-nftables`); the five earlier captures predate the `nft` section.
- The synthetic estate's zone-based firewalls carry zone and service groups (one retired, unused), rules that name
  them, a forgotten any-any allow on some, a narrower copy of an earlier rule on some, and a cleanup deny; their own
  random stream keeps the rest of the estate unchanged.
- Appliance collectors (PAN-OS XML API, FortiOS REST, ASA CLI) emit the same attributes when vendor access lands; the
  read model needs no change for them. NAT is reported but does not take part in the traffic check.
