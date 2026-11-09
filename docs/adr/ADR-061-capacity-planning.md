# ADR-061 — Capacity planning: space, power, cooling and ports per rack and room, from stored data only

Status: Accepted · Date: 2026-11-09 · Tracker: REQ-DCIM-007 · Contracts: GraphQL 1.34.0

## Context

CAPABILITY-MAP.md §4 lists "capacity planning: space, power, cooling, ports" at parity with Device42's capacity views.
The DCIM screens already hold every input: rack units and device placements (REQ-DCIM-001), the power chain with
PDU ratings (REQ-DCIM-004), measured PDU draw in ClickHouse (REQ-DCIM-005), cooling units and their rated capacity
(REQ-DCIM-006), and the interfaces of each network device with their operational state (discovery). What was missing
was the question an operator asks before a delivery arrives: where does this go, and for how long will the room take
more.

## Decision

1. **One query, `roomCapacity(roomId)`.** Per rack: space (units, occupied, free, the contiguous free blocks and the
   largest), power (design watts from the rack's `designKw`, else the sum of its PDU ratings, against the latest
   measured PDU draw), ports (live against total on the rack's network devices, load balancers, FC switches and
   patch panels: a port is live when its interface's operational status is up; a device's `portCount` wins over the
   interface count when larger). For the room: the same totals, cooling (rated kW of the units located in the room
   or cooling its racks against the room's IT load), and a power trend.
2. **States share the DCIM lines.** 70 % used is a warning, 90 % critical (`CAPACITY.warnPercent`,
   `CAPACITY.criticalPercent`); a dimension with nothing to measure against, or a rack with no reading, is unknown
   and is never shown as healthy.
3. **The trend is a least-squares line over daily averages.** Each PDU's daily average draw over the last
   `CAPACITY.trendDays` (30) is summed across the room; a forecast needs `CAPACITY.trendMinPoints` (7) days, and the
   days to each line are counted from the current measured load at that slope. A falling or flat trend says so.
4. **"What fits" is arithmetic on the client.** The view takes a device's height, draw and ports and packs it into
   each rack's free blocks, bounded by the power headroom (design minus load) and the free ports, and totals the
   room. The free blocks travel with the query (`SpaceCapacity.freeBlocks`), so the form recomputes without a round
   trip. The arithmetic lives in `packages/contracts/src/capacity.ts`, shared with the API and unit-tested once.
5. **Nothing is estimated.** No sample means an unknown state; no cooling unit means no cooling percent; a rack
   without PDUs has zero design power only when it also has no `designKw`.

## Consequences

- GraphQL 1.34.0 (additive): `CapacityState`, `SpaceCapacity`, `PowerCapacity`, `PortCapacity`, `CoolingCapacity`,
  `CapacityTrend`, `RackCapacity`, `RoomCapacity`, query `roomCapacity`. Prometheus
  `openmap_dcim_capacity_reads_total`; span `dcim.capacity.room`.
- The Capacity tab joins the DCIM screen (racks, floor plan, power, environment, cabling). Playwright covers it in en
  and ar; `CapacityView.test.tsx` covers the sort, the fit and the figures.
- Port liveness follows the interface's reported status. A patched but administratively down port counts as free;
  cable records (ADR-056) are the stricter view and stay on the Cabling tab.
- Future: a trend per rack and a reservation of units for planned assets (ADR-034's received plan lines) would let
  the fit count honour what is on order; neither is needed for the parity row.
