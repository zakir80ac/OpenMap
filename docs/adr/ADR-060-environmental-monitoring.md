# ADR-060 — Environmental monitoring: temperature, humidity and airflow

Status: Accepted (REQ-DCIM-006, 2026-11-09) · Date: 2026-11-09 · Tracker: REQ-DCIM-006 · Contract: GraphQL 1.33.0

## Context

REQ-DCIM-006 asks for environmental monitoring (temperature, humidity, airflow) at Device42 parity
(docs/CAPABILITY-MAP.md §4). The SNMP collector already read Liebert cooling units (temperature and humidity tables,
cooling capacity) and ENTITY-SENSOR probes (RFC 3433), but only as CI attributes: there was no history, no rack-level
reading and no judgement.

## Decision

1. **Readings are samples on the CI they describe.** No new CI type is needed.
   - **Metrics** (`ENV_METRICS`): `dcim.env.temperature_c`, `dcim.env.humidity_rh`, `dcim.cooling.capacity_percent`.
     A `position` label says where the sensor sits: inlet, outlet, supply, return or room.
   - **Rack inlet and outlet** are on the rack, or on a PDU located in the rack when the probe is plugged into the PDU.
   - **Supply and return air, humidity and capacity** are on the cooling unit.
   - **Room humidity** is on the room.
   - **The SNMP collector emits them.** Liebert table readings get a sensor index. ENTITY-SENSOR probes get their
     name, and the position their name states (`sensorPosition`: "Rack Inlet", "Supply Air", "Return Air",
     "Exhaust").
   - No collector contract version moves, because samples exist since 0.2.0.
2. **States follow ASHRAE TC 9.9 class A1** (`ENVIRONMENT`):
   - **Inlet temperature:** 18–27 °C recommended (normal), 15–32 °C allowable (warning), outside that critical.
   - **Humidity:** 8–80 % RH allowable, with 60 % RH the recommended upper limit. The recommended lower limit is a
     −9 °C dew point, which a single RH reading cannot judge, so only the allowable floor is checked.
   - **Airflow:** the rise across a rack (outlet − inlet) above 20 °C is flagged. Servers are designed for roughly
     10–20 °C at full load, so more means starved airflow or recirculation.
   - A reading older than `ENVIRONMENT.freshMs` (three hourly sweeps) is shown but not judged.
3. **API (GraphQL 1.33.0):** `roomEnvironment(roomId, hours)` returns:
   - each rack's latest inlet and outlet, rise, inlet series, temperature and airflow states, and the worse of the
     two;
   - the room's humidity and state;
   - each cooling unit's supply, return, humidity and capacity;
   - a summary.

   Reads are counted (`openmap_environment_reads_total`) and traced (`dcim.environment.room`).
4. **Alerting runs in the BSM engine** (`service/environment.ts`).
   - A rack whose fresh inlet is outside the allowable range opens one incident (source `environment`, the rack as root
     cause); back inside, it is resolved.
   - `metrics_latest` keeps no labels, so the inlet readings are read from `metrics` over the freshness window.
   - Counted as `openmap_bsm_environment_alerts_total`.
5. **Screen.** The DCIM switch gains an Environment view for a room and a window:
   - the totals, the hottest inlet and the room humidity;
   - each rack's inlet trend, inlet, outlet, rise and states;
   - the cooling units.
6. **The synthetic estate exercises the real pipeline.** `synth environment-history` gives every rack, room and cooling
   unit a profile seeded by its identity: most racks in range, a few warm, a rare one hot, a few with starved airflow;
   humid rooms now and then. It emits their readings every few hours under the collector's metric names. The dev
   tenant holds 14 days of them (13,566 samples).

## Consequences

- The thresholds are the A1 envelope, not tenant settings. A hall designed for another class (A2 to A4) would need the
  envelope per tenant or room; that is a later change.
- Rack sensors are found on the rack and on its PDUs. Probes on other devices (a top-of-rack switch's inlet sensor)
  are not mapped to the rack yet.
- Additions only: GraphQL 1.32.0 → 1.33.0.
