# ADR-058 — Power chain, redundancy findings and PDU outlets

Status: Accepted (REQ-DCIM-004, 2026-11-09) · Date: 2026-11-09 · Tracker: REQ-DCIM-004 · Contract: GraphQL 1.31.0

## Context

REQ-DCIM-004 asks for power at Device42 parity (docs/CAPABILITY-MAP.md §4): PDUs, outlets, feeds, circuits, UPS and
redundancy. The estate already records the chain as `powered_by` relationships:
- a UPS (`ratedKw`, `loadPercent`, `batteryRuntimeMinutes`, `feed`) feeds a power circuit (`ratedAmps`, `voltage`,
  `phases`, `feed`);
- the circuit feeds a rack's PDU (`ratedAmps`, `inputVoltage`, `measuredKw`, `outlets`, `feed`);
- the PDU feeds devices, with `feed` and `psu` on the device's relationship.

The DCIM screen showed only the PDUs powering the selected rack. Nothing said what fails when one side of an A/B pair
is lost, and nobody could record which outlet a device is plugged into. Monitoring thresholds and billing by outlet
are REQ-DCIM-005.

## Decision

1. **The assessment is a pure contract function** (`packages/contracts/src/power.ts`, `assessPower`). Each finding is
   one of:
   - `single_corded`: a device on one PDU;
   - `same_feed`: a device whose cords are all on one feed;
   - a failover overload, for a pair of PDUs in a rack, circuits in a room or UPS units in a room
     (`pdu_failover_overload`, `circuit_failover_overload`, `ups_failover_overload`): the survivor would carry both
     loads and that is more than its rating;
   - `ups_low_runtime`: runtime under `POWER.minUpsRuntimeMinutes`;
   - `outlets_exceeded`: more cords than outlets.

   Capacity comes from ratings:
   - a circuit's watts are √3 × V × A for three phases (`circuitRatedWatts`), V × A otherwise;
   - a PDU's are its amps × volts;
   - a UPS's are its kW.

   Load comes from measurements: a PDU's measured kW, a circuit's sum of the room's PDUs on it, a UPS's load percent of
   its rating. A pair with an unmeasured member is not judged; nothing is assumed.
2. **API (GraphQL 1.31.0).**
   - `powerChain(roomId)`: the room's UPS units, circuits and PDUs, each with feed, rating, load, what feeds it and,
     for PDUs, outlets used of outlets. It also carries the findings and a summary, including the devices that
     survive the loss of one feed. A room is the scope, because a pair is judged within it.
   - `pduConnections(pduId)`: a PDU's cords by outlet.
   - Operators record a cord on an outlet with `connectPower(deviceId, pduId, outlet, psu)`. The cord takes the PDU's
     feed. The outlet must be within the PDU's count and free, and power-chain CIs cannot be plugged into a PDU.
   - `disconnectPower(id)` removes a cord.
   - Writes go through the outbox, with `dcim.power.connected` / `dcim.power.disconnected` audit actions,
     `openmap_power_connections_total` and `dcim.power.*` spans.
3. **Screen.** The DCIM switch gains a Power view, which shows for the room:
   - the totals;
   - the redundancy findings with what fails and by how much;
   - the chain by kind (UPS, circuits, PDUs) with load against rating;
   - a PDU's outlets with the device, PSU and feed on each, where operators plug and unplug devices.

## Consequences

- Outlets already in use but never numbered (as discovered cords usually are) show as "not recorded". Recording them
  is how the plan becomes outlet-exact. The PDU collector reporting per-outlet state (REQ-DCIM-005) fills them in.
- A circuit feeding PDUs in several rooms is judged on each room's share. The partner circuit takes the same rooms'
  loads, so the comparison holds per room; a cross-room total waits for a site-level view.
- Additions only: GraphQL 1.30.0 → 1.31.0.
