# ADR-059 — Power monitoring, thresholds and billing by outlet

Status: Accepted (REQ-DCIM-005, 2026-11-09) · Date: 2026-11-09 · Tracker: REQ-DCIM-005 · Contract: GraphQL 1.32.0

## Context

REQ-DCIM-005 asks for power monitoring, thresholds and billing by outlet (docs/CAPABILITY-MAP.md §4, `collectors/pdu`).
Before this decision:
- the SNMP collector read PDU totals and APC per-outlet watts, but only as CI attributes, so there was no time series;
- outlets were `power_feed` CIs the PDU contains;
- the DCIM thresholds were fixed constants used for colouring;
- nothing computed energy, nothing raised an alert on power, and no tariff existed.

## Decision

1. **Readings are samples.**
   - The SNMP collector emits `dcim.power.watts` for a PDU's total draw and `dcim.outlet.watts` for every metered
     outlet. Each sample is on the outlet's `power_feed` CI, with `pdu` and `outlet` labels.
   - A `Metered` flag keeps an outlet the PDU did not report (Raritan names only) distinct from one drawing 0 W.
   - No contract version moves: samples have been in the collector contract since 0.2.0, and the metric names are
     strings.
2. **Energy is integrated between samples only** (`energyOf`, trapezoid rule). Nothing is extrapolated before the
   window's first sample or after its last. Every energy figure carries the hours its samples span, so a sparse series
   reads as such.
3. **A device on an outlet** is found in one of two ways:
   - `powered_by` the outlet CI itself, as outlets are modelled;
   - a cord to the PDU carrying the outlet's number, as an operator records it (ADR-058).

   Its owning cost centre is the asset register's (`ownerCostCentreCiId`), which is what makes billing by outlet a
   chargeback.
4. **Thresholds and tariff are tenant data** (`power_settings`, migration 0042): the warning and critical lines as a
   percent of a PDU's rating, and a price per kWh with its currency.
   - Without a row, the DCIM defaults apply.
   - Without a tariff, no price is shown, rather than an invented one.
   - `powerSettingsSchema` keeps the critical line above the warning line, and a tariff with its currency.
5. **Alerting runs in the BSM engine** (`service/power.ts`, every `POWER.alertEvaluateMs`).
   - Each PDU's latest draw (`metrics_latest`) is compared with its rating (`pduRatedWatts`) and the critical line.
   - Crossing the line opens one incident (source `power`, the PDU as root cause, severity high). Falling back resolves
     it.
   - A reading older than `POWER.alertFreshMs` is not judged, so a PDU that stopped being read is a discovery problem,
     not a power one.
6. **API and screen (GraphQL 1.32.0).**
   - `powerSettings`, `updatePowerSettings` (administrators, audited).
   - `powerMonitor(roomId, hours)`: each PDU's series, latest reading, state, peak, energy and cost; the outlets' energy
     with their devices; billing by device with the cost centre; totals.
   - Reads are counted (`openmap_power_monitor_reads_total`) and traced (`dcim.power.monitor`). Alerts are counted as
     `openmap_bsm_power_alerts_total`.
   - The Power view gains a monitoring panel: window, totals, PDU draw sparklines with state, billing by device, and
     the lines and tariff for administrators.
7. **The synthetic estate exercises the real pipeline.** `synth power-history` numbers each PDU's cords onto its
   outlets (cords past the outlet count get none, as on an over-full PDU) and emits the used outlets as `power_feed`
   CIs. Each device is `powered_by` its outlet, and every few hours the outlets' and PDUs' draw is emitted, the PDU
   total following the draw the estate reported for it. The dev tenant holds 4,433 outlets and 14 days of readings
   from it.

## Consequences

- **Re-observed relationships keep their attributes.** The reconciler creates relationships but does not update the
  attributes of one it already holds, so a collector reporting a changed attribute on an existing relationship is not
  reflected. Device-to-outlet is therefore modelled as its own relationship. Updating relationship attributes on
  re-observation is a reconciler follow-up.
- Real per-outlet readings come from APC PDUs today. Raritan outlet power and other vendors need recorded walks from
  real devices (R-004, REQ-QA-003).
- Additions only: GraphQL 1.31.0 → 1.32.0; migration 0042.
