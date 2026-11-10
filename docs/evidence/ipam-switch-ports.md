# Switch ports, MAC tables and port history (REQ-IPAM-004, ADR-063)

Captured 2026-11-10 on the dev compose stack with the synthetic estate. The dev tenants were replayed before the
generator learned MACs on top-of-rack ports, so on the live screen the ports carry state, speed, VLAN, description and
neighbour but no learned MACs yet, and a MAC lookup answers that the address has not been seen; the integration test
seeds learned MACs, owners, ARP records and history versions to exercise every path.

## What the Switch ports tab shows

- **Switch search**: switches, load balancers and FC switches matching the text, chosen from a list.
- **MAC lookup**: any spelling (`aa:bb:cc:dd:ee:ff`, `aa-bb-…`, `aabb.ccdd.eeff`, bare hex) is canonicalised and
  answered with where it was learned (switch and port), the ARP records carrying it (with the IP) and the CIs owning it.
- **Six totals**: ports, up, down, admin down, unused for 30+ days, learned MACs.
- **Port table**: name, state (with the unused mark and days not up), speed, VLAN, description, the neighbour on the far
  end (LLDP/CDP `connected_to` or a server's `cabled_to`, with the remote port), and the learned MACs with their owner
  and IP; the first 48 ports, then all on request.
- **Port history**: the last 90 days of recorded versions from ClickHouse `ci_history`, newest change first: state,
  speed, description, VLAN, learned MACs, each with before and after.

## Where the facts come from

| Fact              | Source                                                                                                                                 |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Port state, speed | SNMP IF-MIB ifOperStatus, ifAdminStatus, ifHighSpeed/ifSpeed on the `interface` CI (`portFacts` in `switch-ports.ts`)                  |
| VLAN              | Q-BRIDGE-MIB dot1qPvid on the interface                                                                                                |
| Learned MACs      | Q-BRIDGE `dot1qTpFdbPort/Status`, else BRIDGE-MIB `dot1dTpFdbPort/Status`, learned entries only, mapped through `dot1dBasePortIfIndex` |
| Owner of a MAC    | a CI whose primaryMac, macAddress, mac or ifPhysAddress matches (case-insensitive)                                                     |
| IP of a MAC       | an ARP `ip_address` CI carrying the MAC                                                                                                |
| Neighbour         | `connected_to` either direction (cable ends excluded) or `cabled_to`                                                                   |
| History           | `ci_history` versions in the window plus the last before it, `argMax(attributes, recorded_at)` per `valid_from`                        |

Timing on the dev stack: `switchPorts` about 40 ms warm for a 48-port switch; `macLookup` 125 ms on a 550k-CI tenant
(the owner query dominates).

## Tests

| Test                                                                | What it proves                                                                                                                                                                                                                                                                                 | Result                       |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `apps/collectors/internal/snmp/fdb_test.go` (T-554)                 | Q-BRIDGE and BRIDGE-MIB walks parsed into learned MACs per interface, Q-BRIDGE preferred, non-learned entries dropped, the per-port cap with the true count, a device without a forwarding table emits no MAC attributes, the MAC read from the OID index                                      | 4 passed                     |
| `packages/contracts/src/switch-ports.test.ts` (T-555)               | MAC normalisation in every spelling, port state, speed, unused by history, change diffing over the history keys                                                                                                                                                                                | 5 passed (contracts 90)      |
| `apps/api/src/ipam/switch-ports.integration.test.ts` (T-556)        | on the compose stack: a switch's ports with neighbour, learned MACs resolved to owner and IP, the summary, the unused port, port history from ClickHouse newest first, MAC lookup on the port, in the ARP record and as the owner's address in any spelling, an unknown device or port refused | 4 passed                     |
| `apps/console/src/components/ipam/SwitchPortsView.test.tsx` (T-557) | switch search offers switches only, the port table with state, unused mark, neighbour and MAC labels, port history, MAC lookup in canonical form and refusal of text that is not a MAC, in en and ar                                                                                           | 5 passed                     |
| `apps/console/e2e/screens.spec.ts` (IPAM)                           | on the live stack: the Switch ports tab, a top-of-rack switch by search, its port table and totals, a port's history, a MAC lookup answered; screenshots `ipam-switch-ports-{en,ar}.png`                                                                                                       | 3 of 3 (setup, en, ar), 11 s |

Guard ok; `contracts:check` GraphQL 1.36.0 additive; i18n in sync (57 keys per locale); console unit suite 372 passed;
Go collector tests and synth-estate tests (41) passed.
