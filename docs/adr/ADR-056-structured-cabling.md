# ADR-056 — Structured cabling: patch panels, cables, cross-connects and circuits as CIs

Status: Accepted (REQ-DCIM-001, 2026-11-09) · Date: 2026-11-09 · Tracker: REQ-DCIM-001 · Contracts: CI 0.9.0, collector 0.9.0, GraphQL 1.29.0

## Context

REQ-DCIM-001 asks for cabling, patch panels, circuits and cross-connects at Device42 parity
(docs/CAPABILITY-MAP.md §3). The CI contract already named `cable` and `patch_panel`, but nothing created them. Cabling
existed only as relationships: `cabled_to` from a host to a switch interface, and `connected_to` between interfaces
from LLDP. Nobody could record a patch panel, follow a path through one, or record a carrier circuit.

Two neighbouring requirements own the rest of the area, and this decision leaves room for both:
- REQ-DCIM-004 owns power (PDUs, outlets, feeds, power circuits).
- REQ-DCIM-008 owns cable labels printed and verified against LLDP.

## Decision

1. **Every record is a CI, written through the outbox.** The graph, search, history, the CI detail and impact then work
   on cabling as on everything else.
   - **Patch panel** (`patch_panel`, identity rack + name): `located_in` its rack, with its rack unit (`uPosition`,
     `heightU` 1) on the relationship, so rack elevations show it.
     - Attributes: positions (at most `CABLING.maxPanelPorts`), media, connector.
   - **Cable** (`cable`, identity label + both end keys): `connected_to` each end.
     - The relationship carries the end (`A`/`B`), the port and, on a panel, the side (`front`/`rear`).
     - Kinds are `patch`, `trunk` and `cross_connect`. A colocation cross-connect is a cable whose ends are the cage's
       panels.
     - Attributes: media, length, colour.
   - **Circuit** (`circuit`, a new CI type, identity circuit id + provider): `connected_to` its A and Z ends the same way.
     - Attributes: kind (internet, MPLS, point to point, wavelength, dark fibre, voice), status (planned, provisioning,
       active, decommissioned) and bandwidth.
     - A Z end outside OpenMap (the provider's POP) is a description.
     - `site_link` stays the IPAM view of a WAN link between two sites (ADR-025). A circuit is the physical termination.
2. **Panel positions are not CIs.** A position is a number on the panel CI, and the cable's relationship names it.
   - This keeps a 48-port panel one CI rather than 97.
   - It needs no new `*Ref` target, so the identity-ref trigger (ADR-045) is untouched.
   - An end is unique by (CI, port, side). A port takes one cable or circuit; a second is refused with the holder's
     name.
3. **Rules live in the contract** (`packages/contracts/src/cabling.ts`, CI 0.9.0):
   - `endpointProblem`: a panel position needs a side and a number within the panel, and other CIs take no side.
   - A cable joins two different ports.
   - `traceCable` walks the path: the cable or circuit on a port to its other end; through a panel to the same
     position's other side; until it reaches a port that is not a panel position.
     - The path is incomplete when it stops at an unpatched panel side.
     - It is looped when it returns to a port it passed, or exceeds `CABLING.maxTraceHops`.
   - Adding the CI type moves the CI contract to 0.9.0, and the collector contract and the Go `contract.Version` with it
     (they share the JSON Schema version). Migration 0040 adds `circuit` to the `CiType` enum, and Memgraph migration
     `0002_circuit` adds its label index.
4. **API (GraphQL 1.29.0).**
   - Queries:
     - `cabling`: totals, panels with every position (front cable, rear cable, circuit), cables, circuits.
     - `cableTrace(endpoint)`.
   - Operator mutations:
     - `upsertPatchPanel`: the rack and name cannot change, and a panel cannot shrink below a position in use.
     - `removePatchPanel`: refused while a cable or circuit is on it.
     - `connectCable` and `disconnectCable`: disconnecting retires the cable with its ends.
     - `upsertCircuit`: its terminations are replaced on update.
     - `removeCircuit`.
   - Every write is audited (`cabling.*` actions), counted (`openmap_cabling_changes_total{kind,op}`) and traced
     (`cabling.*` spans).
   - Enum-valued attributes are nullable in GraphQL, because cable and panel CIs can also arrive by CMDB import with
     values outside the lists.
5. **Screen.** The DCIM screen gains a Racks / Cabling switch. The Cabling tab shows:
   - the totals;
   - panels with rack, unit, media and use, and the selected panel's position grid (front and rear cables, circuits);
   - cables and circuits, where every end is a button that opens the trace of the path from it.

   Operators mount and remove panels, connect and disconnect cables, and record and remove circuits. A cable end is
   chosen from the tenant's patch panels or found by search among DC, network and hardware CIs.

## Consequences

- Cabling entered by people sits beside what discovery observes. Comparing the two (an LLDP neighbour against the
  patched path) is REQ-DCIM-008, which can now read both.
- A trace loads the tenant's cables and circuits. That is fine for structured cabling, which counts in the thousands
  per site. A tenant with hundreds of thousands of cables would need the trace in Memgraph instead.
- Additions only:
  - CI 0.8.0 → 0.9.0 and collector 0.8.0 → 0.9.0 (one new CI type, no payload change);
  - GraphQL 1.28.0 → 1.29.0.
