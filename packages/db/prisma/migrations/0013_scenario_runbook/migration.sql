-- REQ-BSM-003 (ADR-019) — the scenario's runbook (impactScenarioSchema.runbook): the contract carried it from the
-- start but no column stored it, so every scenario read failed the contract parse with "runbook: expected object".
ALTER TABLE "impact_scenarios" ADD COLUMN "runbook" JSONB;
