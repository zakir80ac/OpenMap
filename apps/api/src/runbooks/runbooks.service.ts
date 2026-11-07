// REQ-BSM-005 (ADR-048) — runbook use cases: the tenant's catalogue, attaching a runbook to a scenario or an incident,
// and running a step on an incident. A manual step is recorded as done. An automated step passes the outbound gate
// (deployment flag, air-gap profile, tenant setting), resolves its integration's credential from OpenBao and is
// delivered through the BSM engine's deliver(): an AWX job-template launch, an XSOAR playbook, or a POST for any other
// automation vendor. Every delivery is an integration_deliveries row and every step run a runbook_step_runs row.
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { authHeaders, automationRequest, deliver, type DeliveryDeps } from '@openmap/bsm-engine';
import { RUNBOOK_AUTOMATION_CATEGORIES, remainingRunbookMinutes, runbookMinutes, type RunbookRecord, type RunbookStepOutcome, type RunbookStepRun } from '@openmap/contracts';
import { withSpan } from '@openmap/telemetry';
import { CI_REPOSITORY, type CiRepository } from '../ci/ci.repository.js';
import { nowIso } from '../common/time.js';
import { PrismaService } from '../db/prisma.service.js';
import { INTEGRATIONS_REPOSITORY, type IntegrationsRepository } from '../integrations/integrations.repository.js';
import { IntegrationsService } from '../integrations/integrations.service.js';
import { SecretsService } from '../integrations/secrets.service.js';
import { TRACER_NAME } from '../metrics/graphql-metrics.hook.js';
import { MetricsService } from '../metrics/metrics.service.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { RUNBOOKS_REPOSITORY, type IncidentForRunbook, type RunbooksRepository } from './runbooks.repository.js';
import type { RunbookInput } from './runbooks.schemas.js';

export interface RunbookActor {
  tenantId: string;
  username: string;
}

/** The incident's runbook figures the console shows. */
export interface IncidentRecovery {
  estimateMinutes: number | null;
  remainingMinutes: number | null;
}

const AUTOMATION_CATEGORIES: ReadonlySet<string> = new Set(RUNBOOK_AUTOMATION_CATEGORIES);

@Injectable()
export class RunbooksService {
  /** Replaceable for tests; the global fetch, real sleep and clock in production. */
  delivery: DeliveryDeps = { fetchImpl: fetch, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: nowIso };

  constructor(
    @Inject(RUNBOOKS_REPOSITORY) private readonly repo: RunbooksRepository,
    @Inject(INTEGRATIONS_REPOSITORY) private readonly integrationsRepo: IntegrationsRepository,
    @Inject(CI_REPOSITORY) private readonly cis: CiRepository,
    private readonly integrations: IntegrationsService,
    private readonly secrets: SecretsService,
    private readonly outbox: OutboxService,
    private readonly prisma: PrismaService,
    private readonly metrics: MetricsService,
  ) {}

  list(tenantId: string): Promise<RunbookRecord[]> {
    return this.repo.list(tenantId);
  }

  async byId(tenantId: string, id: string | null): Promise<RunbookRecord | null> {
    if (id === null) return null;
    return (await this.repo.byIds(tenantId, [id]))[0] ?? null;
  }

  async upsert(actor: RunbookActor, id: string | null, input: RunbookInput): Promise<RunbookRecord> {
    await this.assertAutomations(actor.tenantId, input);
    if (id !== null && (await this.byId(actor.tenantId, id)) === null) throw new NotFoundException('runbook ' + id + ' not found');
    return this.outbox.transaction(actor.tenantId, async ({ tx, emit }) => {
      const runbook = await this.repo.upsert(tx, actor.tenantId, id, input);
      await emit({ type: 'openmap.audit.action', subject: runbook.id, data: { action: id === null ? 'runbook.created' : 'runbook.updated', runbookId: runbook.id, code: runbook.code, steps: runbook.steps.length, by: actor.username } });
      return runbook;
    });
  }

  delete(actor: RunbookActor, id: string): Promise<boolean> {
    return this.outbox.transaction(actor.tenantId, async ({ tx, emit }) => {
      const deleted = await this.repo.delete(tx, actor.tenantId, id);
      if (deleted) await emit({ type: 'openmap.audit.action', subject: id, data: { action: 'runbook.deleted', runbookId: id, by: actor.username } });
      return deleted;
    });
  }

  async attachToScenario(actor: RunbookActor, scenarioId: string, runbookId: string | null): Promise<void> {
    await this.assertRunbook(actor.tenantId, runbookId);
    await this.outbox.transaction(actor.tenantId, async ({ tx, emit }) => {
      if (!(await this.repo.setScenarioRunbook(tx, actor.tenantId, scenarioId, runbookId))) throw new NotFoundException('scenario ' + scenarioId + ' not found');
      await emit({ type: 'openmap.audit.action', subject: scenarioId, data: { action: 'runbook.attached', scenarioId, runbookId, by: actor.username } });
    });
  }

  async attachToIncident(actor: RunbookActor, incidentId: string, runbookId: string | null): Promise<void> {
    await this.assertRunbook(actor.tenantId, runbookId);
    await this.outbox.transaction(actor.tenantId, async ({ tx, emit }) => {
      if (!(await this.repo.setIncidentRunbook(tx, actor.tenantId, incidentId, runbookId))) throw new NotFoundException('incident ' + incidentId + ' not found');
      await emit({ type: 'openmap.audit.action', subject: incidentId, data: { action: 'runbook.attached', incidentId, runbookId, by: actor.username } });
    });
  }

  scenarioRunbook(tenantId: string, scenarioId: string): Promise<RunbookRecord | null> {
    return this.repo.scenarioRunbookId(tenantId, scenarioId).then((id) => this.byId(tenantId, id));
  }

  async incidentRunbook(tenantId: string, incidentId: string): Promise<RunbookRecord | null> {
    return this.byId(tenantId, (await this.repo.incident(tenantId, incidentId))?.runbookId ?? null);
  }

  /** Offered while an incident has none: the runbook of the saved scenario of its root cause. */
  async suggestedRunbook(tenantId: string, incidentId: string): Promise<RunbookRecord | null> {
    const incident = await this.repo.incident(tenantId, incidentId);
    if (incident === null || incident.runbookId !== null || incident.rootCauseCiId === null) return null;
    return this.byId(tenantId, await this.repo.runbookIdForRootCause(tenantId, incident.rootCauseCiId));
  }

  runs(tenantId: string, incidentId: string): Promise<RunbookStepRun[]> {
    return this.repo.runs(tenantId, incidentId);
  }

  async recovery(tenantId: string, incidentId: string): Promise<IncidentRecovery> {
    const runbook = await this.incidentRunbook(tenantId, incidentId);
    if (runbook === null) return { estimateMinutes: null, remainingMinutes: null };
    return { estimateMinutes: runbookMinutes(runbook), remainingMinutes: remainingRunbookMinutes(runbook, await this.repo.runs(tenantId, incidentId)) };
  }

  /** Runs one step of the incident's runbook and records the run, whatever its outcome. */
  async runStep(actor: RunbookActor, incidentId: string, order: number, note: string | null): Promise<RunbookStepRun> {
    const incident = await this.repo.incident(actor.tenantId, incidentId);
    if (incident === null) throw new NotFoundException('incident ' + incidentId + ' not found');
    const runbook = await this.byId(actor.tenantId, incident.runbookId);
    if (runbook === null) throw new BadRequestException('incident ' + incidentId + ' has no runbook attached');
    const step = runbook.steps.find((s) => s.order === order);
    if (step === undefined) throw new NotFoundException('runbook ' + runbook.code + ' has no step ' + String(order));
    let outcome: RunbookStepOutcome = 'done';
    let delivered: { integrationId: string; deliveryId: string | null; remoteId: string | null; error: string | null } | null = null;
    if (step.automation !== null) {
      const automation = step.automation;
      delivered = await withSpan(TRACER_NAME, 'runbook.step', { 'openmap.tenant': actor.tenantId, 'openmap.incident': incidentId, 'openmap.runbook.step': order }, () =>
        this.trigger(actor.tenantId, incident, runbook, step, automation),
      );
      outcome = delivered.error === null ? 'triggered' : 'failed';
    }
    const run = await this.outbox.transaction(actor.tenantId, async ({ tx, emit }) => {
      const saved = await this.repo.recordRun(tx, actor.tenantId, {
        incidentId,
        runbookId: runbook.id,
        order,
        outcome,
        actor: actor.username,
        note,
        integrationId: delivered?.integrationId ?? null,
        deliveryId: delivered?.deliveryId ?? null,
        remoteId: delivered?.remoteId ?? null,
        error: delivered?.error ?? null,
        at: nowIso(),
      });
      await emit({ type: 'openmap.audit.action', subject: incidentId, data: { action: 'runbook.step.run', incidentId, runbookId: runbook.id, order, outcome, by: actor.username } });
      return saved;
    });
    this.metrics.runbookSteps.inc({ outcome });
    return run;
  }

  /** Delivers the step's automation; a refused gate, a missing credential or a failed delivery comes back as `error`. */
  private async trigger(
    tenantId: string,
    incident: IncidentForRunbook,
    runbook: RunbookRecord,
    step: RunbookRecord['steps'][number],
    automation: { integrationId: string; action: string },
  ): Promise<{ integrationId: string; deliveryId: string | null; remoteId: string | null; error: string | null }> {
    const base = { integrationId: automation.integrationId, deliveryId: null, remoteId: null };
    try {
      await this.integrations.assertOutboundAllowed(tenantId);
      const config = await this.integrationsRepo.config(tenantId, automation.integrationId);
      if (!config.enabled) return { ...base, error: 'integration ' + config.name + ' is disabled' };
      const headers = authHeaders(config.vendor, await this.secrets.read(config.credentialRef));
      const names = new Map((await this.cis.findByIds(tenantId, [...incident.affectedServiceCiIds, ...(incident.rootCauseCiId === null ? [] : [incident.rootCauseCiId])])).map((c) => [c.id, c.displayName]));
      const req = automationRequest(
        automation.action,
        {
          incidentId: incident.id,
          title: incident.title,
          severity: incident.severity,
          rootCause: incident.rootCauseCiId === null ? null : (names.get(incident.rootCauseCiId) ?? incident.rootCauseCiId),
          services: incident.affectedServiceCiIds.map((id) => names.get(id) ?? id),
          step: { order: step.order, instruction: step.instruction },
          runbookCode: runbook.code,
        },
        config,
      );
      const outcome = await deliver({ config, path: req.path, method: req.method, headers, body: req.body, eventId: null }, this.delivery);
      const d = outcome.delivery;
      await this.prisma.client.integrationDelivery.create({
        data: {
          id: d.id,
          tenantId,
          integrationId: config.id,
          direction: d.direction,
          eventId: d.eventId,
          remoteId: d.remoteId,
          state: d.state,
          attempts: d.attempts,
          requestDigest: d.requestDigest,
          responseCode: d.responseCode,
          error: d.error,
          createdAt: new Date(d.createdAt),
          completedAt: d.completedAt === null ? null : new Date(d.completedAt),
        },
      });
      return { integrationId: config.id, deliveryId: d.id, remoteId: outcome.remoteId, error: d.state === 'delivered' ? null : (d.error ?? d.state) };
    } catch (err) {
      return { ...base, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async assertRunbook(tenantId: string, runbookId: string | null): Promise<void> {
    if (runbookId !== null && (await this.byId(tenantId, runbookId)) === null) throw new NotFoundException('runbook ' + runbookId + ' not found');
  }

  /** Every automation names an integration of the tenant whose category runs playbooks or jobs. */
  private async assertAutomations(tenantId: string, input: RunbookInput): Promise<void> {
    const ids = [...new Set(input.steps.flatMap((s) => (s.automation === null ? [] : [s.automation.integrationId])))];
    const found = new Map((await this.integrations.byIds(tenantId, ids)).map((i) => [i.id, i]));
    for (const id of ids) {
      const integration = found.get(id);
      if (integration === undefined) throw new BadRequestException('integration ' + id + ' not found');
      if (!AUTOMATION_CATEGORIES.has(integration.category)) throw new BadRequestException('integration ' + integration.name + ' is a ' + integration.category + ' integration; a runbook step triggers ' + RUNBOOK_AUTOMATION_CATEGORIES.join(' or '));
    }
  }
}
