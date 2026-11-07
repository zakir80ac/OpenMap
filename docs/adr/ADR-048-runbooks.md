# ADR-048 — Runbooks: a tenant catalogue attached to scenarios and incidents, steps that trigger automation

Status: Accepted (REQ-BSM-005, 2026-11-08) · Date: 2026-11-08 · Tracker: REQ-BSM-005, REQ-BSM-003, REQ-UI-012, REQ-UI-013

## Context

REQ-BSM-005 asks for runbooks attached to scenarios and incidents, with an automation hook per step:

- `runbookSchema` stored and shown on the impact and incident screens;
- steps that trigger SOAR or Ansible through integrations;
- a recovery estimate that sums the step minutes.

The design cue came from the Incident Sandbox review (docs/DESIGN-CUES.md): an SOP runbook with steps next to every
prepared failure scenario.

- The impact contract has carried `runbookSchema` since REQ-BSM-003: steps with an order, an instruction, an optional
  automation `{ integrationId, action }` and estimated minutes.
- Migration 0013 added an `impact_scenarios.runbook` JSON column so scenario reads parse. No writer ever filled it, and
  it is empty on every database we run.
- An embedded copy per scenario could not be shared with incidents, nor kept current when the procedure changes.
- Outbound delivery exists only for incidents: the BSM engine pushes them to ITSM, SIEM and paging tools through
  `deliver()`, with retries and an `integration_deliveries` row per attempt.
- The API has the outbound gate (`IntegrationsService.assertOutboundAllowed`: the deployment flag, the air-gap profile
  and the tenant setting) and OpenBao credentials (`SecretsService`).

## Decision

1. **A runbook catalogue per tenant** (`runbooks`, migration 0033), keyed by `code` (unique in the tenant). It stores
   `runbookSchema`: title, owner team, last review date and ordered steps. Steps are validated by the contract, and an
   automation must name an enabled integration of category `soar` or `automation` (`RUNBOOK_AUTOMATION_CATEGORIES`).
2. **Attachment by reference.**
   - `impact_scenarios.runbookId` and `incidents.runbookId` (both `ON DELETE SET NULL`) replace the embedded column,
     which 0033 drops. The scenario contract still carries `runbook`, now resolved from the reference.
   - A scenario's runbook is set when it is saved (`ScenarioInput.runbookId`) or later (`setScenarioRunbook`). An
     incident's runbook is set by an operator (`setIncidentRunbook`).
   - An incident with none is offered the runbook of the saved scenario of its root cause, when there is one.
3. **Running a step** (`runRunbookStep(incidentId, order, note)`) records a `runbook_step_runs` row: actor, time,
   outcome and, for automation, the integration, delivery and remote id.
   - A manual step records `done`.
   - An automated step passes the outbound gate, resolves its credential from OpenBao and is delivered through the BSM
     engine's `deliver()` (retries, an `integration_deliveries` row). It records `triggered`, or `failed` with the error.
   - The request is the vendor's documented API (`automationRequest`): see the table below.
   - The incident's id, title, severity, root cause and services travel as variables. The remote id comes from the
     integration's `settings.remoteIdPath`, as for incidents.
4. **Recovery estimates.**
   - `runbookMinutes` is the sum of the steps' estimated minutes, null when no step has one.
   - A simulation whose scenario has a runbook with an estimate takes it as the outage length for the SLA budget, and
     leads its recommendations with "follow the runbook".
   - An incident shows the total and the minutes still to go: steps whose latest run is not `done` or `triggered`.
5. **Contracts.** These are additions only:
   - Impact 1.2.0: `runbookRecordSchema`, `RUNBOOK_AUTOMATION_CATEGORIES`, `RUNBOOK_STEP_OUTCOMES`,
     `runbookStepRunSchema`, `runbookMinutes` and `remainingRunbookMinutes`.
   - GraphQL 1.20.0: `Runbook`, `RunbookStep`, `RunbookAutomation`, `RunbookStepRun` and the inputs; queries
     `runbooks` and `runbook`; mutations `upsertRunbook`, `deleteRunbook`, `setScenarioRunbook`, `setIncidentRunbook`
     and `runRunbookStep`; `ImpactScenario.runbook`, `Incident.runbook`, `Incident.suggestedRunbook`,
     `Incident.runbookRuns`, `Incident.recoveryEstimateMinutes` and `Incident.recoveryRemainingMinutes`.
   - No event type is added: saves, attachments and runs emit `openmap.audit.action`.
6. **Observability.** Step runs are counted by `openmap_runbook_steps_total{outcome}`, and each automated step runs in
   a `runbook.step` span.

`automationRequest` per vendor:

| Vendor | Request |
| --- | --- |
| `ansible_awx` | `POST api/v2/job_templates/{action}/launch/` with `extra_vars` |
| `cortex_xsoar` | `POST incident` with `playbookId = action` and `createInvestigation` |
| other automation vendors and `webhook` | `POST` to the endpoint with `{ action, incident, step }` |

## Consequences

- One procedure serves every scenario and incident that names it. Editing a runbook changes what all of them show; a
  step run keeps the order it ran, not the text.
- Automation never runs in the air-gap profile, or when the tenant has outbound integrations off. A manual step can
  always be marked done.
- The vendor requests follow the vendors' public API documentation. No vendor response is recorded or fabricated: the
  tests check the request OpenMap sends with an in-test receiver, and the remote id is read only where the
  integration's settings name its path.
