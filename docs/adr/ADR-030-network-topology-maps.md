# ADR-030 — Network topology maps from neighbour links, cabling and addressing

Status: Accepted and implemented (REQ-DEP-001, 2026-11-05) · Date: 2026-11-05 · Tracker: REQ-DEP-001

## Context

The SNMP collector already walks LLDP-MIB `lldpRemTable` and records each neighbour as a `connected_to` relationship
between two `interface` CIs (protocol, remote port, remote system); every interface is `contains`-ed by its device;
servers are `cabled_to` the top-of-rack port they plug into; devices and their interfaces `uses_ip` addresses that
are `in_subnet` a subnet. The Dependencies screen drew one CI's impact closure; nothing drew the network itself.
Device42's "Network topology maps (L2/L3, LLDP/CDP)" (CAPABILITY-MAP §3) had no counterpart.

## Decision

1. **The topology is a query, not stored state.** `networkTopology(layer, siteId, includeHosts)` (GraphQL 1.6.0,
   additive) reads the current relationships in Postgres:
   - **L2**: device ↔ device through the neighbour link between two of their interfaces (`connected_to`, both ends
     `contains`-ed by a network device or load balancer), with the host attachments (`cabled_to` from a host or
     hypervisor to a device port) when `includeHosts` is set;
   - **L3**: device → subnet through every address the device or one of its interfaces uses.
   A site narrows the map to the devices whose `located_in` chain (rack, room, building) reaches it within
   `TOPOLOGY.siteHops`.
2. **One link per pair.** `apps/api/src/graph/topology.ts` folds raw edges into one link per node pair and kind
   (a neighbour link seen from both ends is one link) carrying every interface pair, the protocols, the media and the
   slowest speed. The map is capped at `TOPOLOGY.maxNodes` by degree so a large estate keeps its backbone, and says
   when it was cut. Span `topology.<layer>`, histogram `openmap_topology_duration_seconds{layer}`.
3. **The console draws it with the impact map's machinery.** The Dependencies screen gains a view switch (Impact ·
   Network topology, `view=topology` in the URL); the topology view reuses the Sigma canvas and the force layout
   worker, colours edges by the relationship family each link stands for (connectivity, placement, addressing),
   draws network gear large and endpoints small, and lists a clicked device's links with interface pairs, speed,
   protocol and media, with a link to that device's impact map. Layer, site and host toggle live in the URL.

## Consequences

- No new store, no new collector: the map is as current as the last SNMP sweep and the cabling records, and time
  travel follows when the query takes `asOf` (the relationships are bitemporal; left for when the screen asks).
- CDP neighbours arrive through the same `connected_to` shape once the Cisco family walk records them (vendor
  fixtures pending, R-004); the map needs no change for them.
- REQ-DEP-004's layered enterprise view groups the derived component dependencies of ADR-029 over this physical map;
  both are views of the same relationships.
