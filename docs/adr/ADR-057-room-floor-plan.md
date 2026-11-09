# ADR-057 — Room floor plan: rows, aisles, rack slots and heat on the DCIM screen

Status: Accepted (REQ-DCIM-003, 2026-11-09) · Date: 2026-11-09 · Tracker: REQ-DCIM-003 · Contract: GraphQL 1.30.0

## Context

REQ-DCIM-003 asks for room layouts and floor plans: a room view with heat colouring, at Device42 parity
(docs/CAPABILITY-MAP.md §4). Two views already existed:

- the digital twin (ADR-018), which places rooms, rows and racks in 3D and colours racks by load;
- the DCIM screen's heat map, a flat grid of a room's racks.

Neither shows the room as it is laid out: rows in order along the room, which aisle each faces, which slots are free.
Neither lets anyone change the layout.

The estate already carries the layout:
- row CIs (`located_in` their room) have `position` along the room, `aisle` (cold or hot) and `rackCapacity`;
- racks (`located_in` their row) have `row` and `position`.

## Decision

1. **The plan is a pure function of the `racks` query** (`apps/console/src/lib/floor-plan.ts`).
   - The query now also reads each row's attributes; the GraphQL `Ci.attributes` field already existed.
   - For each room, its rows are ordered by `position`. Each row is slotted up to its `rackCapacity`, or to its
     furthest rack, with the rack in each slot.
   - Racks in no row share one row per room.
   - Two racks reporting the same slot both stay visible: the later one takes the next slot past the row.
2. **Heat comes from readings only.** There are three measures:
   - measured power against the feeds' rating;
   - measured power against the rack's design power (`designKw`);
   - units in use against the rack's height.

   A rack with no reading for the measure has no heat and shows as "no reading", never as a guessed value. The bands
   are the DCIM thresholds (`DCIM.warnPowerPercent`, `DCIM.criticalPowerPercent`). Temperature waits for REQ-DCIM-006,
   which brings environmental sensors.
3. **Moving a rack is `placeRack(rackId, rowId, position)`** (operators, GraphQL 1.30.0).
   - A rack's identity is its room and name, so it moves only within its room.
   - The slot must be within the row's capacity, when the row states one, and free; a taken slot is refused with the
     name of the rack in it.
   - The rack's `row` and `position` attributes change and its `located_in` moves to the row, through the outbox with
     a `dcim.rack.placed` audit action, an `openmap_rack_moves_total` count and a `dcim.rack.place` span.
   - The twin reads the same attributes, so it follows the move.
4. **Screen.** The DCIM screen's switch becomes Racks / Floor plan / Cabling.
   - The plan shows the room's rows with their aisle and slot tiles, each named with its rack and heat.
   - Choosing a rack shows its three readings and a link to the twin.
   - Operators move it by choosing a free slot on the plan, which fills the form, or a row and slot by hand.

## Consequences

- The plan draws rows and slots, not walls, doors or tile coordinates. Rooms are laid out as their rows. Drawing room
  outlines and placing cooling units would need room geometry the estate does not record yet.
- Empty rows (with no rack yet) are not on the plan, because it is built from racks. Making a new row is the job of
  the import or onboarding flows.
- Additions only: GraphQL 1.29.0 → 1.30.0.
