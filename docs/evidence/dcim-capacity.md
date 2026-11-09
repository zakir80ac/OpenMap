# Capacity planning: space, power, cooling, ports (REQ-DCIM-007, ADR-061)

Captured 2026-11-09 on the dev compose stack with the synthetic estate (2,526 racks of 42 U and 8 kW design, 5,053
PDUs, cooling units of 120 and 150 kW, 138,910 interfaces with IF-MIB status).

## What the Capacity tab shows

- **Four figures for the room**: rack units used, power drawn against design, cooling load against rated capacity,
  ports live against total, each with its state against the DCIM lines (70 % warning, 90 % critical). A dimension with
  nothing to measure against is "not measured" and unknown, never healthy.
- **Totals**: free units and the largest contiguous free block, watts drawn of design, kW of IT load against rated
  cooling and the number of units, live ports of total.
- **Power trend**: a least-squares line over each PDU's daily average draw summed across the room for the last 30
  days, the slope in kW per day and the days left to the warning and critical lines at that slope; with fewer than
  seven days of readings the card says how many it has and gives no forecast.
- **What fits**: a device's height, draw and ports (2 U, 500 W, 2 ports by default); the count packs the device into
  every rack's free blocks within its power and port headroom and totals the room, recomputed on each keystroke.
- **Racks, worst first**: free units, largest block, power drawn of design with percent, free ports of total, the fit
  count and the state; 24 rows then "show all".

## Where the figures come from

| Figure                       | Source                                                                                                                                                                            |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Units, occupied, free blocks | the rack's `heightU` and each device's `uPosition`/`heightU` on its `located_in` or `mounted_on` relationship (REQ-DCIM-001)                                                      |
| Design power                 | the rack's `designKw`, else the sum of its PDU ratings (`ratedWatts`, or amps × volts)                                                                                            |
| Drawn power                  | the latest `dcim.power.watts` sample per PDU in ClickHouse `metrics_latest`; a PDU with no sample falls back to its reported `measuredKw`; none at all leaves the rack unknown    |
| Ports                        | network devices, load balancers, FC switches and patch panels in the rack: `portCount` or the count of their `interface` CIs, whichever is larger; live when `ifOperStatus` is up |
| Cooling                      | cooling units located in the room or cooling its racks: `coolingKw`; the load is the room's drawn power                                                                           |
| Trend                        | `metrics` daily averages per PDU over 30 days, summed per day, least squares (`linearTrend`), `daysUntil`                                                                         |

## Tests

| Test                                                             | What it proves                                                                                                                                                                                                                                                                                                                                                     | Result                       |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------- |
| `packages/contracts/src/capacity.test.ts` (T-546)                | free blocks with clipping and overlaps, states against the lines, the trend and the days to a line (no forecast under seven points, flat and falling trends), the fit count by space, power and ports                                                                                                                                                              | 4 passed (contracts 82)      |
| `apps/api/src/dcim/capacity.integration.test.ts` (T-547)         | a seeded room against the compose stack: 42 U rack with a 2 U server and a 48-port switch (3 interfaces, 2 up), 16 A PDU with eight rising days of draw ending at 3.4 kW, a 10 kW cooling unit: 39 U free in blocks of 2 and 37, 3,400 of 8,000 W normal, 2 of 48 ports, 34 % cooling, slope 0.1 kW/day with 22 and 38 days to the lines; a non-room id is refused | 2 passed                     |
| `apps/console/src/components/dcim/CapacityView.test.tsx` (T-548) | sort worst first, the fit summary (a rack without design power or counted ports is unconstrained there), the four figures and their states, totals, trend days, rack rows and the fit recomputed when the height changes, in en and ar                                                                                                                             | 3 passed                     |
| `apps/console/e2e/screens.spec.ts` (DCIM)                        | the Capacity tab on the live stack: figures, rack rows, the what-fits form, screenshots `dcim-capacity-{en,ar}.png`                                                                                                                                                                                                                                                | 3 of 3 (setup, en, ar), 10 s |

Guard ok; `contracts:check` GraphQL 1.34.0 additive; i18n in sync (42 keys per locale). Lighthouse dcim 0.97 / 1 / 1 (performance / accessibility / best practices), measured alone on the CPU with the kind cluster stopped.
