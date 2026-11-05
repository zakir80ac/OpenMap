# Network topology maps at layer 2 and layer 3 (REQ-DEP-001, ADR-030)

Captured 2026-11-05 on the dev compose stack with the synthetic estate (tenant
`ac9a6a65-1f19-4ecf-bf16-b3a90e42cc5c`: 246 network devices, 5,270 interfaces, 463 LLDP neighbour links,
3,833 host cables, 5,870 addresses in subnets).

## What changed

1. **API** (`apps/api/src/graph/topology.ts`, `topology.service.ts`): `networkTopology(layer, siteId, includeHosts)`
   (GraphQL 1.6.0) reads the current relationships in Postgres. L2 joins devices through the LLDP/CDP neighbour link
   between two of their interfaces and, on request, attaches hosts by their cabling to a device port; L3 joins
   devices to the subnets of the addresses they or their interfaces use. A site narrows the map through the
   `located_in` chain. Raw edges fold into one link per node pair (both directions of a neighbour link are one link)
   with every interface pair, the protocols, the media and the slowest speed; the map is capped at
   `TOPOLOGY.maxNodes` by degree and says when it was cut. Span `topology.<layer>`, histogram
   `openmap_topology_duration_seconds{layer}`.
2. **Console** (`apps/console/src/components/dependencies/TopologyView.tsx`, `ViewSwitch.tsx`, `topology-graph.ts`):
   the Dependencies screen switches between the impact map and the network topology (`view=topology`). The topology
   view has the layer (L2/L3), the site and the attached-hosts toggle in the URL, draws the map on the same Sigma
   canvas and force-layout worker as the impact map, colours links by what they stand for, and lists a clicked
   device's links (interface pairs, speed, protocol, media) with a link to its impact map.
3. **Layout fix found on the way.** Every topology node sits in one layer, so the force layout's lane seed put them
   all on one row and the forces never left it (the first screenshot showed a line). `LayoutRequest.seed: 'circle'`
   starts the force layout on a circle around the root; the impact map keeps its lane seed.
4. **Route fix found on the way.** The server page first called `parseView` from a client module and the whole
   route failed to render; the parser now lives in the server-safe `params.ts`.

## On the dev estate

| Map | Nodes | Links | Query |
| --- | --- | --- | --- |
| L2, all sites | 252 | 459 | 58 ms |

The e2e also verifies that the attached-hosts toggle grows the node count and that the L3 map draws devices and
subnets.

## Tests

| Id | What | Result |
| --- | --- | --- |
| T-153 | `apps/api/src/graph/topology.test.ts`: both directions of a neighbour link fold into one link with every interface pair and the slowest speed, host and subnet kinds stay apart, self-links dropped, the node cap keeps the busiest nodes | 3 of 3 |
| T-154 | `apps/api/src/graph/topology.integration.test.ts` through GraphQL against the estate: L2 neighbour links with interface pairs, LLDP and speed; hosts attach on request; a site narrows the map; L3 joins devices to subnets | 2 of 2 |
| T-155 | `apps/console/src/components/dependencies/TopologyView.test.tsx` (en, ar) and the circle-seed case in `graph-layout.test.ts`: the map, the URL-driven layer, site and host choices, a device's links with their evidence, the impact link, the two-dimensional seed | 5 of 5; 33 of 33 with the layout and dependency suites |
| T-156 | Playwright `apps/console/e2e/topology.spec.ts` (en, ar): switch to the topology view, L2 map drawn, hosts toggle grows the map, L3 drawn | 2 of 2 (with setup 3 of 3) |

Also green: `pnpm guard`, `pnpm i18n:check` (27 new keys per locale), `pnpm contracts:check` (1.6.0 additive),
console lint, API unit suite (34).

## Screenshots

- `console/topology-l2-en.png`, `console/topology-l2-ar.png`: the L2 map of all sites.
- `console/topology-l3-en.png`, `console/topology-l3-ar.png`: the L3 map with hosts toggled off.
