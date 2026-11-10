# ADR-063 — Switch ports: learned MAC tables, port state history and MAC lookup

Status: Accepted · Date: 2026-11-10 · Tracker: REQ-IPAM-004 · Contracts: GraphQL 1.36.0

## Context

CAPABILITY-MAP.md §5 lists "switch port mapping with MAC tables" and "port history" as IPAM capabilities: for every
switch port, what is plugged in (the learned MACs and the CI that owns each), whether the port is in use, and how it
changed. The SNMP collector already emitted each interface as an `interface` CI with ifOperStatus, ifAdminStatus,
speed, MTU, alias and PVID, and the LLDP/CDP neighbour as `connected_to`; ARP entries were already emitted as
`ip_address` CIs carrying the MAC. What was missing was the bridge forwarding table, a read model over the ports, and
the history of a port across versions.

## Decision

1. **The SNMP collector walks the forwarding table.** It walks Q-BRIDGE-MIB `dot1qTpFdbPort/Status` and BRIDGE-MIB
   `dot1dTpFdbPort/Status`; Q-BRIDGE wins when a device answers both (it is per VLAN and the newer table). Only
   entries with status `learned` (3) count; self and management entries are dropped. Bridge ports map to interfaces
   through `dot1dBasePortIfIndex`. Each interface carries `learnedMacs` (canonical lower-case colon form, at most
   `maxLearnedMacs` = 64 per port, the first by MAC order) and `learnedMacCount` (the true count). The attributes are
   only emitted when the table was walked, so a device without a bridge MIB never reports "no MACs" by mistake. The
   job option `skipMacTable` turns the walk off for devices where it is slow.
2. **Port facts are computed in one place.** `packages/contracts/src/switch-ports.ts` turns interface attributes into
   a port's state (`up`, `down`, `admin_down`, `unknown`), speed in Mbps, VLAN, learned MACs and whether it is unused,
   and diffs consecutive versions into changes over the keys that matter (`PORT_HISTORY_KEYS`: state, speed, alias,
   PVID, learned MACs). A port is **unused** when it has not been up for `SWITCH_PORTS.unusedDays` (30) days by its
   recorded history; a port with no history is not called unused.
3. **History comes from ClickHouse `ci_history`.** A port's versions in the window
   (`SWITCH_PORTS.historyDays`, 90) plus the last version before it are read with `argMax(attributes, recorded_at)`
   per `valid_from`, capped at `maxHistoryVersions`; the current Postgres row is the fallback when the history store
   has nothing yet. Changes are listed newest first; changes recorded at one instant keep the key order.
4. **MACs resolve to owners in SQL.** A learned MAC is matched against the MAC attributes a CI may carry
   (`MAC_OWNER_ATTRIBUTES`: primaryMac, macAddress, mac, ifPhysAddress, compared lower-case), and an ARP
   `ip_address` CI with the same MAC gives the IP. MAC lookup (`macLookup`) accepts any spelling (colon, dash, Cisco
   dotted, bare hex), canonicalises it, and returns where it was learned, the ARP records carrying it and the CIs owning
   it, at most `macLookupLimit` (50) sightings.
5. **Neighbours are the observed adjacency.** The far end of a port is its `connected_to` (either direction, cable ends
   excluded) or `cabled_to` relationship, with the remote port and the protocol when discovery reported them.

## Consequences

- GraphQL 1.36.0 (additive): `PortState`, `LearnedMac`, `PortNeighbour`, `SwitchPort`, `SwitchPortSummary`,
  `SwitchPorts`, `PortChange`, `PortHistory`, `MacSightingKind`, `MacSighting`, `MacLookup`; queries `switchPorts`,
  `portHistory`, `macLookup`. Prometheus `openmap_switch_port_reads_total{query}`; spans `ipam.switch.*`.
- The IPAM screen gains a **Switch ports** tab: switch search, MAC lookup, six totals, the port table (first
  `portRows` ports, then all on request) and a port's history.
- The synthetic estate learns each host's primary MAC (and its VMs' MACs) on the top-of-rack ports it is cabled to,
  so replays exercise the read model at scale.
- The recorded SNMP fixtures are Net-SNMP Linux agents, which have no forwarding table; the parser is proven with
  in-code walks shaped like the MIB until vendor-lab captures exist (vendor access is deferred, 2026-11-09).
- Measured on the dev stack: `switchPorts` about 40 ms warm for a 48-port switch; the MAC owner query 125 ms on a
  550k-CI tenant. An expression index on the lower-cased MAC is the follow-up if it grows.
