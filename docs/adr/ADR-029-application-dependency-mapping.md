# ADR-029 — Application dependency mapping: dependencies derived from flows, listeners and processes

Status: Accepted and implemented (REQ-DEP-002, 2026-11-05) · Date: 2026-11-05 · Tracker: REQ-DEP-002

## Context

Collectors already observe the raw material of application dependency mapping: the netflow collector records
flows between addresses as `communicates_with` relationships (destination port, protocol, flows, bytes, packets,
exporters, window); hosts, VMs, containers and workloads record the addresses they use (`uses_ip`); the SSH, WinRM
and agent collectors record every listening socket as a `listening_service` CI with its owning process and a
`runs_on` edge to the compute; application components record the port and protocol they serve and `runs_on` the
compute that hosts them. Nothing joined these into dependencies: the Dependencies screen and the impact query walked
`depends_on` edges that only a collector asserted directly (a cloud account, a VMware cluster) or the synthetic
estate wrote by design. Device42's "Application Dependency Mapping from flows, processes, listeners" (CAPABILITY-MAP
§5) had no counterpart.

## Decision

1. **Derivation runs in the reconciler, from what the stores hold.** `apps/reconciler/src/core/adm.ts` is a pure
   join over a tenant's current flows, address owners, listeners and components:
   - a flow whose server side runs a listener on that protocol and port becomes **client compute → listener**
     `depends_on` (`kind: listener`, confidence `ADM.confidence.listener`), with the listener's process named;
   - a flow to a compute with no listener on that port becomes **client compute → server compute** (`kind: compute`,
     lower confidence; the port is still recorded);
   - when a component on the server side serves the flow's port and the client side runs a component, **client
     component → server component** is derived too (`kind: component`); a client compute running several components
     attributes the traffic to each of them, marked `ambiguous` with a lower confidence.
   Flow endpoints may be addresses (the netflow collector), compute (an agent that resolved its connections, the
   synthetic estate) or a listener; the attribute dialects of both are read (`port` or `dstPort`, `exporters[]` or
   `exporter`, `windowSeconds` before `observedAt` or `firstSeen`/`lastSeen`). Flows under `ADM.minFlows`,
   self-flows and flows from unowned addresses derive nothing. The output is aggregated per edge (ports, flows,
   bytes, packets, exporters, addresses, processes, window) and deterministic.
2. **Derived edges are observations.** The pass (`apps/reconciler/src/worker/adm.ts`) hands new edges to the
   reconciliation pipeline as a collector result from the `adm` source on the `reconciler` node, so they are created,
   versioned, recorded in `relationship_history` and fanned out to Memgraph, ClickHouse and Meilisearch through the
   outbox like any observation. Every derived edge then takes the pass's evidence attributes, run id and kind
   confidence in one statement per batch (the pipeline stamps a created relationship with the reconciler's default
   confidence, so fresh edges need it too). Edges a previous pass derived that the flows no longer support are
   retired (`validTo`) with the same `openmap.relationship.retired` event the API emits; an edge whose flow returns
   is created again. One `openmap.dependency.derived` event (event contract 0.6.0) summarises each pass.
3. **When it runs.** After any reconciled result that carried a flow, an address, a listener or a component
   (`ADM.triggerCiTypes`, `ADM.triggerRelationshipTypes`), debounced per tenant by `ADM.debounceMs` so a sweep of
   many results runs it once; at the end of a replay; and on demand with `pnpm --filter @openmap/reconciler adm
   [--tenant <id>]`. Metrics `openmap_reconciler_adm_passes_total{outcome}`,
   `openmap_reconciler_adm_edges_total{action}` and `openmap_reconciler_adm_duration_seconds`; span `reconcile.adm`.
4. **The console shows the evidence.** The Dependencies side panel lists the focus CI's observed traffic: what it
   talks to and what talks to it, with protocol and ports, flows and bytes, the process, the last-seen instant, the
   confidence and the ambiguity note; the edges themselves are ordinary `depends_on` edges on the map and in the
   impact query, so blast radius and service impact follow observed traffic without a separate model.

## Consequences

- No GraphQL change: `Ci.relationships` already exposes attributes and provenance; the console query now asks for
  them. Event contract 0.6.0 (`openmap.dependency.derived`). Constants `ADM` and `BYTES`.
- The evidence on a derived edge lives on the Postgres row the API reads; the graph carries the edge and its
  provenance. A later pass refreshes the row in place rather than re-versioning the edge, so the history keeps one
  version per edge lifetime.
- The synthetic estate's flows are already resolved to compute → listener (its IPFIX exporters stand on the core
  switches that see both ends); on the dev stack the pass derives 7,434 listener, 148 component and 5 compute edges
  from 7,495 flows in under a second, and a second pass refreshes them all and creates none.
- A derived edge ends on the listener, not on the host that runs it, so a server host's own panel lists the
  traffic it sends; what it receives is on the listener CIs (one click away on the map and in the CI detail). A
  host-level roll-up of received traffic is a presentation change for REQ-DEP-004's layered view, not a second edge.
- Network topology from LLDP/CDP (REQ-DEP-001) and the layered enterprise view (REQ-DEP-004) build on this: a
  derived `depends_on` between components is what the layered map groups, and `connected_to` from neighbour tables is
  the next derivation of the same shape.
