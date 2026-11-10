# Firewall rules and policy objects (REQ-IPAM-005, ADR-064)

Captured 2026-11-10 on the dev compose stack. The dev tenant's network results were regenerated (seed 42, scale 0.05)
and only `snmp.ndjson` was replayed without a reset: 85 CIs created, 3,897 updated, no conflicts. The tenant now holds
77 firewall rules and 72 policy objects on its 8 edge firewalls. The same replay brought the REQ-IPAM-004 learned MACs
onto the switch ports, so `ipam-switch-ports-{en,ar}.png` were retaken.

## Where the rules come from

| Source                               | How                                                                                                                                                                                                                                    |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Linux hosts (nftables, iptables-nft) | The agentless SSH collector runs `sudo -n nft -j list ruleset` (one sudoers entry for exactly that command; without it nothing is reported): chains, rules in order, counters, log flags, base chain policies, named sets              |
| Zone-based firewalls                 | One ordered list with `fromZone` / `toZone`, as the synthetic estate's edge firewalls carry it and as PAN-OS, FortiOS and ASA collectors will emit it once vendor access lands                                                         |
| Recorded capture                     | `packages/testing/fixtures/vendor/ssh_agentless/debian-debian-12-nftables`: the real collector against a Debian 12 container with a typical server rule set (three sets, default-drop input, jump/return user chain, DNAT, masquerade) |

## What the Firewall tab shows

- **Check a connection**: source, destination, protocol, port and optional zones; every firewall (or only the chosen
  one) answers allowed, denied, rejected or no match, with the deciding rule and the rules it could not tell. On the
  dev tenant, trust → dmz TCP 443 is denied by the cleanup rule on six firewalls and allowed on two by a forgotten
  `temp-any-allow`, which is exactly what the check is for.
- **Seven totals**: rules, allow, deny or reject, shadowed, never hit, any-service allow, unused objects.
- **Chains** with hook and policy, for devices with chains (nftables).
- **Rules** in evaluation order: zones or interface, source, destination, service, action (with jump target or NAT
  translation), hits, conditions, findings; a filter for rules with findings. On `dmm-fw-edge-01` the narrower copy
  `partner-to-trust-narrow` (10.32.161.0/25) is shadowed by `partner-to-trust-60` (10.32.161.0/24, same zones, port
  and action).
- **Policy objects** with kind, members and how many rules use each; groups no rule names (`net-legacy`, and
  `svc-web` on that device) are marked.

## Tests

| Test                                                                  | What it proves                                                                                                                                                                                                                                                                                          | Result                       |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `apps/collectors/internal/sshlinux/firewall_test.go` (T-558)          | the recorded capture parsed into 21 rules (16 plus 5 chain policies) and 3 sets with exact matches, verdicts, jump and NAT targets, counters, conditions; the emitted rule and set CIs and `depends_on` links; transport-header ports, negation, goto, SNAT, comparison operators and concatenated sets | 3 passed                     |
| `apps/collectors/internal/sshlinux/fixture_test.go` (T-300, extended) | the new capture through every parser with expectations computed independently from the transcript (CPU 61.5894 %, memory 45.3034 %, disk 27.4581 %); the five older captures predate the `nft` section                                                                                                  | 6 captures passed            |
| `packages/contracts/src/firewall.test.ts` (T-559)                     | IPv4 and IPv6 prefixes, ranges, nested groups, negation; services with port sets, ranges, ICMP types, protocol numbers; evaluation with uncertain rules, jumps, returns, goto and policies, zone lists; shadowed (redundant and conflicting, merged prefixes), unused, permissive rules, unused objects | 9 passed (contracts 99)      |
| `apps/api/src/ipam/firewall.integration.test.ts` (T-560)              | on the compose stack: a zone-based policy with its findings and object use; per-device and per-chain verdicts with the deciding rule and uncertain rules; devices, a host policy and a check over GraphQL; an address that is not one refused                                                           | 3 passed                     |
| `apps/console/src/components/ipam/FirewallView.test.tsx` (T-561)      | totals, chains, rule rows with scope, conditions and findings, the findings filter, objects with the unused one marked; the check refusing a bad address, sending the connection across firewalls and on the chosen one, ICMP without a port; en and ar                                                 | 5 passed                     |
| `apps/console/e2e/screens.spec.ts` (IPAM)                             | on the live stack: the Firewall tab, a firewall's totals, rules and objects, a connection checked across every firewall; screenshots `ipam-firewall-{en,ar}.png`                                                                                                                                        | 3 of 3 (setup, en, ar), 15 s |

Guard ok; `contracts:check` GraphQL 1.37.0 additive; CI and collector contracts 0.10.0 with the Go `contract.Version`;
Prisma migration 0043 and Memgraph 0003 applied to the dev stack; i18n in sync (96 keys per locale); console unit suite
377 passed; synth-estate 41 passed.
