# ADR-053 — Anomaly rules over discovery and health events

Status: Accepted (REQ-AI-003, 2026-11-08) · Date: 2026-11-08 · Tracker: REQ-AI-003 · Contract: GraphQL 1.25.0

## Context

REQ-AI-003 asks for a rule engine with LLM explanations, and its acceptance is that known anomalies in the synthetic
estate are flagged. The estate planted no anomalies, so nothing defined which findings were "known".

## Decision

1. **Three rules, each over one store** (`ANOMALY_RULES`, pure functions in `@openmap/assistant`):
   - **`ip_conflict`:** an address that two or more current CIs claim through `uses_ip` (Postgres). In the synthetic
     estates no address had a second claimant, so a second claimant is never ordinary.
   - **`unmanaged_device_in_datacenter`:** a CI of type `unknown`, with no user label, located in a site of kind
     `datacenter` or `colocation`. The CI is walked up `located_in` (Postgres). Labelling or classifying it (ADR-052)
     clears the finding.
   - **`flapping_service`:** a business service with `ANOMALY.flapChanges` (6) health changes inside
     `ANOMALY.flapWindowHours` (6), over the last `ANOMALY.flapLookbackDays` of `service_health_history` (ClickHouse).
     The estates' ordinary history peaks at 2 changes in any six-hour window.
2. **Planted ground truth** (`tools/synth-estate`). Each planting uses its own seeded stream, so no other generated
   value moves.
   - **IP conflict:** a Raspberry Pi gateway answering on a server's address. It is a server's address, not another
     unknown device's, because the reconciler treats two unknown CIs on one address as the same device.
   - **Unmanaged device:** an unidentified camera in the primary data centre, plus every scanned device the generator
     places there.
   - **Flapping service:** a burst of `ANOMALY.synthetic.flapOutages` short outages on one service, a few hours before
     `--now`.
   - **Recording:** they go in `estate-summary.json` and `health-history.json` under `anomalies`.
3. **Findings** (`anomaly_findings`, migration 0038): one per rule and subject.
   - A finding is open while its rule holds, refreshed with the latest facts, and cleared when the rule stops.
   - The API evaluates every `ANOMALY_INTERVAL_MS` (env, default 5 minutes) for every tenant. Operators can run the
     rules at once with `detectAnomalies`.
   - `openmap_anomaly_findings_total` counts outcomes by rule, and an `anomaly.detect` span covers each evaluation.
4. **Explanations on demand** (`explainAnomaly`).
   - The local model explains a finding from its facts only: what it means, why it matters and what to check first.
     The explanation is kept until the facts change.
   - In locales the model does not write well (`ASSISTANT_PROSE_LOCALES`, as ADR-028 decided for answers), the
     explanation is the catalogue's template (`anomaly.explainTemplate.*`) filled with the facts. On the CPU profile
     that means Arabic: the 1.5B model answered an Arabic request in English.
5. **GraphQL 1.25.0 and the Anomalies screen** (`/anomalies`, in the Insight group).
   - GraphQL adds `anomalies`, `detectAnomalies`, `explainAnomaly`, `AnomalyFinding`, `AnomalyFact` and
     `AnomalyReport`.
   - The screen shows open findings first, each with its rule, subject, facts and explanation, with counts per rule.

## Results

Dev tenant (seed 42, scale 0.05), after the planted estate and health history were loaded:

| Measure | Value |
| --- | --- |
| Planted anomalies | 3 |
| Open findings | 3, exactly the planted ones |
| Precision | 1.0 |
| Recall | 1.0 |

The findings were:
- `ip_conflict` on 10.50.0.10, claimed by the server ahv-hq-c01-01 and iot_sensor-b6ff;
- `unmanaged_device_in_datacenter` for camera-6e2c in the Riyadh Primary Data Centre;
- `flapping_service` for SARIE Instant Payments: 8 changes in 6 hours.

Evidence: `docs/evidence/anomalies.json`, T-504 to T-506.

## Consequences

- **Explicit rules.** A new kind of anomaly is a new rule with its own facts query, test and ground truth, not model
  behaviour.
- **The model only words what the rules found.** It never decides what is anomalous.
- **Health history window.** The flapping rule reads 30 days of health history per sweep. On the scale-1 tenant (300
  services), that is about 2,000 rows per tenant per sweep.
- **One explanation per finding.** Asking in another locale replaces the stored one, which is cached per finding and
  locale.
