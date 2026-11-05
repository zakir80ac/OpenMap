# ADR-024 — SLAs are assigned, measured from the health history, and incidents carry response targets and an RCA

Status: Accepted · Date: 2026-11-05 · Tracker: REQ-BSM-006, REQ-BSM-008 · Contracts: GraphQL 1.1.0, event 0.4.0

## Context

Syed's 2026-11-05 review: "Biggest missing thing is SLA assignment and continuous monitoring of SLA, incident alert,
response, logging for audit and a section for RCA entry", and "best in the class uptime monitoring (should have by
month, quarter and yearly)".

What existed (REQ-BSM-002): a `slaTargetPercent` attribute on business-service CIs read by the API, an error budget
over a fixed rolling 30 days computed from `openmap.bsm.health.changed` events read back out of the Postgres outbox,
incidents opened and resolved by the engine with acknowledgement as the only human action, and a
`service_health_history` table in ClickHouse that nothing wrote (empty on the dev stack; 12 health events in
`events`). There was no SLA object to assign, no response or resolution target, no calendar reporting, no RCA.

## Decision

1. **History has one store.** The reconciler's outbox dispatcher writes every `openmap.bsm.health.changed` event as a
   `service_health_history` row (tenant, service, health, score, cause, budget remaining, event time); ClickHouse DDL
   0004 copies the events emitted before the writer existed. The API and the engine read availability from this
   table only; the outbox stays a delivery log.
2. **Availability is pure arithmetic in `@openmap/bsm-engine`** (`core/availability.ts`): walk the ordered health
   changes through a window starting from the state before it; down minutes count against availability; degraded
   minutes are available but reported; unknown minutes (no observation) leave the denominator rather than counting
   as up. Calendar months, quarters and years are cut at local midnight in the tenant's time zone
   (`TenantSettings.timeZone`), so the report reads the way the organisation's calendar does. The error budget of a
   target is taken over the whole window; the burn rate is consumed budget per elapsed share of the window.
3. **An SLA is a row, assigned to a service.** `slas` (name, availability target, window: calendar month, quarter,
   year or rolling 30 days, response and resolution targets by severity, burn-rate alert) and one
   `service_sla_assignments` row per service. An assigned SLA's target replaces the `slaTargetPercent` attribute;
   the attribute remains the fallback a collector or the synthetic estate can supply.
4. **The engine monitors continuously.** Every tick it evaluates each assigned service over the SLA's current window:
   budget exhausted opens one incident of source `sla` (critical for tier 1, high otherwise) and emits
   `openmap.bsm.sla.breached`; a burn rate at or above the SLA's alert threshold emits `openmap.bsm.sla.at_risk`
   once per window; a breach incident from a previous window closes when the new window is within budget. Every
   incident opened by the engine gets `respondBy` and `resolveBy` from the service's SLA (or `SLA.defaultTargets`);
   the tick stamps `responseBreachedAt` when nobody acknowledged in time and `resolutionBreachedAt` when it is not
   resolved in time, each with an `openmap.incident.updated` event that integrations subscribed to incidents receive.
5. **Incident response is a set of audited mutations.** `assignIncident`, `resolveIncident` (with a note),
   `closeIncident` and `updateIncidentRca` join `acknowledgeIncident`; the global audit interceptor records each one
   (actor, arguments, time) and the incident's `timeline` merges those audit entries with the engine's events, so the
   whole history of an incident is readable in one place. The RCA is a structured JSON on the incident: summary, root
   cause CI, contributing factors, corrective actions with owner and due date, owner, due and completion dates.
6. **Reporting.** `ServiceHealth.availability(granularity, periods)` and `availabilityReport` give every service's
   figures per month, quarter or year beside the target, with the incidents open during each period;
   `availabilityReportCsv` is the export. The k6 budget `PERF_BUDGETS.availabilityReportP95Ms` (1 s for the yearly
   roll-up of 300 services) is enforced by guard from `tools/perf/results/availability-report.json`.
7. **Synthetic history is generated, then replayed.** `synth-estate health-history` draws deterministic outages per
   business service over the past months from the estate's seed; `reconciler replay-history` turns them into
   back-dated health events through the outbox (so the dispatcher writes the history rows) and into resolved
   incidents, so the report has a year of data on the dev estate without waiting a year.

## Consequences

- GraphQL 1.1.0 is additive; event 0.4.0 adds `openmap.bsm.sla.at_risk`. Prisma migration 0016, ClickHouse 0004.
- The engine gains a ClickHouse reader (history); the API's SLA budget moves from the outbox to ClickHouse.
- The console's Business services screen gains the SLA catalogue, assignment, the uptime table by month, quarter and
  year with export, and incident response with RCA; `/services/[id]` shows one service's uptime and incidents.
