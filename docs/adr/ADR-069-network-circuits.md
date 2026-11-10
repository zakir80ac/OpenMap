# ADR-069 — Network circuits: the circuit register on inter-site links, carrier circuits under them, path diversity

Status: Accepted (REQ-IPAM-007, 2026-11-10) · Date: 2026-11-10 · Tracker: REQ-IPAM-007 · Contracts: GraphQL 1.41.0

## Context

REQ-IPAM-007 (docs/CAPABILITY-MAP.md §9, parity and more against Device42) asks for inter-site links as CIs with kind,
provider, bandwidth, diverse paths and role, and for their outages to be modelled like any component's.

What existed:

- **Links.** ADR-017 and ADR-025 made inter-site links setup records (`site_links`) with a `site_link` CI. The CI
  carried kind, provider, bandwidth, diverse paths (a count), role, replication and a probe target. The `link_probe`
  collector measures the links, and readiness rules judge them.
- **Carrier circuits.** ADR-056 made the carrier's circuit a `circuit` CI, `connected_to` its A and Z terminations
  (a patch panel position or a router port).

Six gaps remained:

1. A link and the circuits it rides on were not related. A carrier circuit's outage reached nothing in the impact
   graph.
2. `siteLinkSchema.carrierContractRef` was in the contract but stored nowhere. The committed latency (`slaLatencyMs`)
   was read by the rules but could not be entered.
3. A diverse-path claim was a number nobody checked. Two links between the same sites could have the same carrier, the
   same duct or the same carrier circuit, and still count as two paths.
4. A link without a probe had no health unless something wrote a status attribute on it.
5. A link going down between two sites that had more than one path raised nothing, unless the link carried
   replication or a criticality-1 site fell below two paths.
6. Readiness incidents named no business service, even when the impact graph could reach some.

## Decision

1. **The circuit register is the link CI.** One mutation, `saveLinkCircuit(linkId, input)` (operators), writes on any
   `site_link` CI the following attributes:
   - kind, provider, carrier contract (`carrierContractRef`);
   - committed bandwidth and latency;
   - diverse paths and role;
   - the physical route (`pathRef`: a duct, a conduit, a cable system, a right of way);
   - the carrier circuits it rides on (`circuitCiIds`).

   Writing on the CI means it works on set-up and discovered links alike (the ADR-025 principle). A set-up link's
   record follows, so the wizard shows what the CI says. The link's identity (its circuit id and two sites) cannot
   change here.
   - Migration 0046 adds `carrierContractRef`, `slaLatencyMs` and `pathRef` to `site_links`.
   - The setup wizard's link form takes the same three fields.
2. **Carrier circuits are dependencies.** Each chosen circuit becomes a `depends_on` relationship from the link to the
   `circuit` CI (`LINK_CIRCUIT_RELATIONSHIP`), with the attribute `source: circuit_register`. `depends_on` is already an
   impact edge, so the upstream walk from a circuit reaches the link and everything that depends on the link. A save
   replaces the link's `depends_on` edges to circuit CIs and leaves its other `depends_on` edges alone.
   - At most `LINK_CIRCUITS.maxCircuitsPerLink` circuits per link.
   - Every id must be a current `circuit` CI.
3. **Health from circuits.** The BSM engine's readiness evaluation, run every minute, does this:
   - It reads each link's carrier circuits.
   - A circuit's health is its own on the graph, made worse by a down or degraded hand-off port at either end. A
     hand-off port is an `interface` or `port` CI the circuit is `connected_to` (`LINK_CIRCUITS.handOffTypes`). So an
     SNMP-observed port that goes down takes the circuit down.
   - A link that is not probed and rides circuits takes the health of those circuits, in series. If one is down the
     link is down. If one is degraded the link is degraded. If all are healthy the link is healthy. Otherwise its
     health is unknown.
   - The health is set on the graph, and services are recomputed, like a probed link.
   - A probed link keeps its probe verdict, because a measurement beats an inference.
   - The engine's CI-event health rule skips a link whose register names circuits, as it already skips a probed one,
     so the two never fight.
4. **Shared risks** (`sharedRisks` in the BSM engine core, `LINK_SHARED_RISK_KINDS`).
   - Two non-overlay links joining the same two sites, in either direction, share a risk when they have the same
     provider, the same route or a carrier circuit in common.
   - Provider and route are compared without case and surrounding space.
   - An overlay rides another link by definition, so it is never compared.
   - The Sites screen shows each link's shared risks, and so does `ConnectivityLink.sharedRisks`.
5. **Two readiness rules** (`READINESS_RULES`), with findings and incidents as in ADR-025:
   - **`path_diversity`** (severity low). The links of a pair are read primary first, then by name. A link that shares
     a risk with a link read before it breaches, so the backup carries the finding, not the primary. This is a design
     risk: nothing is down yet.
   - **`redundancy_lost`** (severity medium).
     - Scope: two sites that have more than one path between them. Each link counts its diverse paths, and a link
       that is not down counts as up (as in `linkRedundancy`).
     - Every link of theirs that is down breaches, and the detail says how many paths are left.
     - Its incident names the business services the impact graph reaches upstream from the link
       (`GRAPH.defaultImpactDepth`), so the incident is impact-assessed like any component's.
     - Other readiness incidents still name none.
6. **API, console, telemetry.**
   - GraphQL 1.41.0:
     - `ConnectivityLink` gains `carrierContractRef`, `pathRef`, `circuits` (`LinkCircuit`) and `sharedRisks`
       (`LinkSharedRisk`, `LinkSharedRiskKind`);
     - `SiteLink` and `SiteLinkInput` gain `carrierContractRef`, `slaLatencyMs` and `pathRef`;
     - new input `LinkCircuitInput` and mutation `saveLinkCircuit`.
   - The Sites screen:
     - each link row shows the contract, the route, its carrier circuits with their health, and what it shares;
     - the two rules are listed with their findings;
     - an operator opens a link's circuit details and picks carrier circuits from those recorded on the DCIM Cabling
       tab. This works in en and ar.
   - Telemetry:
     - the API traces `connectivity.link_circuit.save` and counts `openmap_link_circuit_changes_total{op}` (`saved`,
       `attached`, `detached`), and every save is audited (`connectivity.link_circuit.saved`);
     - the BSM engine traces `bsm.readiness.circuits`, and `openmap_bsm_readiness_findings_total` gains a `rule`
       label.

## Consequences

- **The REST `/api/v1/connectivity` findings carry the new rule names.** The OpenAPI enum for `rule` gains
  `path_diversity` and `redundancy_lost`. It is the same `READINESS_RULES` list. The change is additive, and the
  REST route table and its fields are otherwise unchanged.
- **T-480 changes.** Its scenario (a replication link down, a backup up, between the same two sites) now also opens
  `redundancy_lost`. That is the intended reading of a pair losing a member.
- **Series, not parallel.** A link that rides several circuits is taken to need all of them: a local loop at each end
  and a backbone. Physically diverse paths of one link are its `diversePaths` count, or separate links. A link that
  really splits over parallel circuits should be recorded as two links, so the rules can judge their diversity.
- **What the impact walk does with intermediate components.** A simulated circuit outage that honours redundancy
  keeps the live health of the components between the circuit and a service (ADR-019). The service is then judged by
  its members, as for any intermediate component. The live path (circuit, then link health, then services) carries
  the outage fully.
- **A route is only as good as its records.** `pathRef` is what operators record. OpenMap cannot see a duct.
  The rule makes a shared record visible, and an unrecorded route is not treated as diverse or as shared.
