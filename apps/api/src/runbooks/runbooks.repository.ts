// REQ-BSM-005 (ADR-048) — runbook persistence: the tenant's catalogue (runbooks), the references scenarios and
// incidents hold (runbookId) and the record of every step run (runbook_step_runs). Interface plus Prisma implementation.
import { Injectable } from '@nestjs/common';
import { runbookRecordSchema, runbookStepRunSchema, type RunbookRecord, type RunbookStepOutcome, type RunbookStepRun } from '@openmap/contracts';
import { Prisma } from '@openmap/db';
import { isoDateOf, isoOf } from '../common/time.js';
import { PrismaService } from '../db/prisma.service.js';
import type { RunbookInput } from './runbooks.schemas.js';

export const RUNBOOKS_REPOSITORY = Symbol('RUNBOOKS_REPOSITORY');

/** What a step run needs from its incident. */
export interface IncidentForRunbook {
  id: string;
  title: string;
  severity: 'informational' | 'low' | 'medium' | 'high' | 'critical';
  rootCauseCiId: string | null;
  affectedServiceCiIds: string[];
  runbookId: string | null;
}

export interface NewStepRun {
  incidentId: string;
  runbookId: string;
  order: number;
  outcome: RunbookStepOutcome;
  actor: string;
  note: string | null;
  integrationId: string | null;
  deliveryId: string | null;
  remoteId: string | null;
  error: string | null;
  at: string;
}

export interface RunbooksRepository {
  list(tenantId: string): Promise<RunbookRecord[]>;
  byIds(tenantId: string, ids: readonly string[]): Promise<RunbookRecord[]>;
  upsert(tx: Prisma.TransactionClient, tenantId: string, id: string | null, input: RunbookInput): Promise<RunbookRecord>;
  delete(tx: Prisma.TransactionClient, tenantId: string, id: string): Promise<boolean>;
  setScenarioRunbook(tx: Prisma.TransactionClient, tenantId: string, scenarioId: string, runbookId: string | null): Promise<boolean>;
  setIncidentRunbook(tx: Prisma.TransactionClient, tenantId: string, incidentId: string, runbookId: string | null): Promise<boolean>;
  scenarioRunbookId(tenantId: string, scenarioId: string): Promise<string | null>;
  incident(tenantId: string, incidentId: string): Promise<IncidentForRunbook | null>;
  /** The runbook of the newest saved scenario that fails exactly this root cause and names one. */
  runbookIdForRootCause(tenantId: string, rootCauseCiId: string): Promise<string | null>;
  runs(tenantId: string, incidentId: string): Promise<RunbookStepRun[]>;
  recordRun(tx: Prisma.TransactionClient, tenantId: string, run: NewStepRun): Promise<RunbookStepRun>;
}

type RunbookRow = Prisma.RunbookGetPayload<object>;
type RunRow = Prisma.RunbookStepRunGetPayload<object>;

function toRunbook(row: RunbookRow): RunbookRecord {
  return runbookRecordSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    code: row.code,
    title: row.title,
    ownerTeam: row.ownerTeam,
    lastReviewedAt: row.lastReviewedAt === null ? null : isoDateOf(row.lastReviewedAt),
    steps: row.steps,
    createdAt: isoOf(row.createdAt),
    updatedAt: isoOf(row.updatedAt),
  });
}

function toRun(row: RunRow): RunbookStepRun {
  return runbookStepRunSchema.parse({
    id: row.id,
    incidentId: row.incidentId,
    runbookId: row.runbookId,
    order: row.order,
    outcome: row.outcome,
    actor: row.actor,
    note: row.note,
    integrationId: row.integrationId,
    deliveryId: row.deliveryId,
    remoteId: row.remoteId,
    error: row.error,
    at: isoOf(row.at),
  });
}

@Injectable()
export class PrismaRunbooksRepository implements RunbooksRepository {
  constructor(private readonly prisma: PrismaService) {}

  async list(tenantId: string): Promise<RunbookRecord[]> {
    return (await this.prisma.client.runbook.findMany({ where: { tenantId }, orderBy: { code: 'asc' } })).map(toRunbook);
  }

  async byIds(tenantId: string, ids: readonly string[]): Promise<RunbookRecord[]> {
    if (ids.length === 0) return [];
    return (await this.prisma.client.runbook.findMany({ where: { tenantId, id: { in: [...ids] } } })).map(toRunbook);
  }

  async upsert(tx: Prisma.TransactionClient, tenantId: string, id: string | null, input: RunbookInput): Promise<RunbookRecord> {
    const data = {
      code: input.code,
      title: input.title,
      ownerTeam: input.ownerTeam,
      lastReviewedAt: input.lastReviewedAt === null || input.lastReviewedAt === undefined ? null : new Date(input.lastReviewedAt),
      steps: input.steps as unknown as Prisma.InputJsonArray,
    };
    const row = id === null ? await tx.runbook.create({ data: { tenantId, ...data } }) : await tx.runbook.update({ where: { id, tenantId }, data });
    return toRunbook(row);
  }

  async delete(tx: Prisma.TransactionClient, tenantId: string, id: string): Promise<boolean> {
    return (await tx.runbook.deleteMany({ where: { id, tenantId } })).count > 0;
  }

  async setScenarioRunbook(tx: Prisma.TransactionClient, tenantId: string, scenarioId: string, runbookId: string | null): Promise<boolean> {
    return (await tx.impactScenario.updateMany({ where: { id: scenarioId, tenantId }, data: { runbookId } })).count > 0;
  }

  async setIncidentRunbook(tx: Prisma.TransactionClient, tenantId: string, incidentId: string, runbookId: string | null): Promise<boolean> {
    return (await tx.incident.updateMany({ where: { id: incidentId, tenantId }, data: { runbookId } })).count > 0;
  }

  async scenarioRunbookId(tenantId: string, scenarioId: string): Promise<string | null> {
    return (await this.prisma.client.impactScenario.findFirst({ where: { id: scenarioId, tenantId }, select: { runbookId: true } }))?.runbookId ?? null;
  }

  async incident(tenantId: string, incidentId: string): Promise<IncidentForRunbook | null> {
    return this.prisma.client.incident.findFirst({
      where: { id: incidentId, tenantId },
      select: { id: true, title: true, severity: true, rootCauseCiId: true, affectedServiceCiIds: true, runbookId: true },
    });
  }

  async runbookIdForRootCause(tenantId: string, rootCauseCiId: string): Promise<string | null> {
    const row = await this.prisma.client.impactScenario.findFirst({
      where: { tenantId, origin: 'user', failedCiIds: { equals: [rootCauseCiId] }, runbookId: { not: null } },
      orderBy: { createdAt: 'desc' },
      select: { runbookId: true },
    });
    return row?.runbookId ?? null;
  }

  async runs(tenantId: string, incidentId: string): Promise<RunbookStepRun[]> {
    return (await this.prisma.client.runbookStepRun.findMany({ where: { tenantId, incidentId }, orderBy: [{ at: 'asc' }, { id: 'asc' }] })).map(toRun);
  }

  async recordRun(tx: Prisma.TransactionClient, tenantId: string, run: NewStepRun): Promise<RunbookStepRun> {
    const row = await tx.runbookStepRun.create({ data: { tenantId, ...run, at: new Date(run.at) } });
    return toRun(row);
  }
}
