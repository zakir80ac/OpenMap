-- REQ-BSM-006 REQ-BSM-008 ADR-024 — service_health_history gains its writer: the outbox dispatcher turns every
-- openmap.bsm.health.changed event into one row (apps/reconciler dispatcher, healthRowFromEvent). The events the
-- engine emitted before that writer existed are still in {database}.events, so they are copied once here; the
-- availability report and the SLA evaluation read this table only. score is the health weight (SLA.healthScore).
INSERT INTO {database}.service_health_history (tenant_id, service_ci_id, health, score, cause_ci_id, sla_budget_remaining_minutes, ts)
SELECT
    tenant_id,
    toUUID(subject) AS service_ci_id,
    JSONExtractString(data, 'state') AS health,
    multiIf(health = 'healthy', 1.0, health = 'degraded', 0.5, 0.0) AS score,
    if(JSONLength(data, 'rootCauseIds') > 0, toUUIDOrNull(JSONExtractString(data, 'rootCauseIds', 1)), NULL) AS cause_ci_id,
    JSONExtract(data, 'budgetRemainingMinutes', 'Nullable(Float64)') AS sla_budget_remaining_minutes,
    time AS ts
FROM {database}.events
WHERE type = 'openmap.bsm.health.changed'
  AND JSONExtractString(data, 'state') IN ('healthy', 'degraded', 'down', 'unknown')
  AND (tenant_id, toUUID(subject), time) NOT IN (SELECT tenant_id, service_ci_id, ts FROM {database}.service_health_history);
