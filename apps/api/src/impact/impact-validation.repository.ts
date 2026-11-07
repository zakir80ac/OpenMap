// REQ-BSM-004 (ADR-047) — persistence for impact prediction accuracy: the resolved incidents still to compare, the
// validations (impact_validations), the relationship suggestions a miss produces (relationship_suggestions) and the
// counts the accuracy panel reads. Interface plus Prisma implementation.
import { Injectable } from '@nestjs/common';
import { IMPACT } from '@openmap/constants';
import { relationshipSuggestionSchema, type RelationshipSuggestion, type RelationshipType, type SuggestionState } from '@openmap/contracts';
import { Prisma } from '@openmap/db';
import { isoOf, toIso } from '../common/time.js';
import { PrismaService } from '../db/prisma.service.js';

export const IMPACT_VALIDATION_REPOSITORY = Symbol('IMPACT_VALIDATION_REPOSITORY');

/** What a validation needs from an incident. */
export interface IncidentToValidate {
  id: string;
  tenantId: string;
  title: string;
  rootCauseCiId: string;
  affectedServiceCiIds: string[];
  openedAt: string;
}

export interface ValidationRecord {
  id: string;
  incidentId: string;
  simulationId: string;
  predictedServiceCiIds: string[];
  actualServiceCiIds: string[];
  missedServiceCiIds: string[];
  accuracy: number;
  validatedAt: string;
}

export interface NewValidation {
  tenantId: string;
  incidentId: string;
  simulationId: string;
  predictedServiceCiIds: string[];
  actualServiceCiIds: string[];
  missedServiceCiIds: string[];
  accuracy: number;
  validatedAt: string;
}

export interface AccuracyCounts {
  validated: number;
  meanAccuracy: number | null;
  exact: number;
  pending: number;
  withoutRootCause: number;
}

export interface ImpactValidationRepository {
  /** Tenants with at least one resolved incident that names a root cause and is not validated yet. */
  tenantsWithPending(): Promise<string[]>;
  /** The oldest resolved incidents of the tenant still to validate. */
  pending(tenantId: string, limit: number): Promise<IncidentToValidate[]>;
  incident(tenantId: string, id: string): Promise<IncidentToValidate | null>;
  /** The latest saved what-if simulation of exactly this root cause run before `before`, if any. */
  priorSimulationId(tenantId: string, rootCauseCiId: string, before: string): Promise<string | null>;
  saveValidation(tx: Prisma.TransactionClient, v: NewValidation): Promise<ValidationRecord>;
  /** Adds one occurrence to the open suggestion, creates it, or leaves an accepted or dismissed one alone. */
  suggest(tx: Prisma.TransactionClient, tenantId: string, type: RelationshipType, fromCiId: string, toCiId: string, incidentId: string): Promise<void>;
  /** The `to` CIs that already have a current relationship of the type from `fromCiId`: those are never suggested. */
  existingPairs(tenantId: string, type: RelationshipType, fromCiId: string, toCiIds: readonly string[]): Promise<Set<string>>;
  counts(tenantId: string): Promise<AccuracyCounts>;
  recent(tenantId: string, limit: number): Promise<ValidationRecord[]>;
  suggestions(tenantId: string, state: SuggestionState, limit: number): Promise<RelationshipSuggestion[]>;
  suggestion(tenantId: string, id: string): Promise<RelationshipSuggestion | null>;
  decide(tenantId: string, id: string, state: Exclude<SuggestionState, 'open'>, by: string, at: string, relationshipId: string | null): Promise<RelationshipSuggestion>;
}

const RESOLVED_STATES = ['resolved', 'closed'] as const;

type IncidentRow = Prisma.IncidentGetPayload<{ select: typeof INCIDENT_SELECT }>;
const INCIDENT_SELECT = { id: true, tenantId: true, title: true, rootCauseCiId: true, affectedServiceCiIds: true, openedAt: true } as const;

function toIncident(row: IncidentRow): IncidentToValidate | null {
  if (row.rootCauseCiId === null) return null;
  return { id: row.id, tenantId: row.tenantId, title: row.title, rootCauseCiId: row.rootCauseCiId, affectedServiceCiIds: row.affectedServiceCiIds, openedAt: isoOf(row.openedAt) };
}

type ValidationRow = Prisma.ImpactValidationGetPayload<object>;

function toValidation(row: ValidationRow): ValidationRecord {
  return {
    id: row.id,
    incidentId: row.incidentId,
    simulationId: row.simulationId,
    predictedServiceCiIds: row.predictedServiceCiIds,
    actualServiceCiIds: row.actualServiceCiIds,
    missedServiceCiIds: row.missedServiceCiIds,
    accuracy: row.accuracy,
    validatedAt: isoOf(row.validatedAt),
  };
}

type SuggestionRow = Prisma.RelationshipSuggestionGetPayload<object>;

function toSuggestion(row: SuggestionRow): RelationshipSuggestion {
  return relationshipSuggestionSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    type: row.type,
    fromCiId: row.fromCiId,
    toCiId: row.toCiId,
    reason: row.reason,
    occurrences: row.occurrences,
    lastIncidentId: row.lastIncidentId,
    state: row.state,
    decidedBy: row.decidedBy,
    decidedAt: toIso(row.decidedAt),
    relationshipId: row.relationshipId,
    createdAt: isoOf(row.createdAt),
    updatedAt: isoOf(row.updatedAt),
  });
}

@Injectable()
export class PrismaImpactValidationRepository implements ImpactValidationRepository {
  constructor(private readonly prisma: PrismaService) {}

  private pendingWhere(tenantId: string): Prisma.IncidentWhereInput {
    return { tenantId, state: { in: [...RESOLVED_STATES] }, rootCauseCiId: { not: null }, validations: { none: {} } };
  }

  async tenantsWithPending(): Promise<string[]> {
    const rows = await this.prisma.client.incident.findMany({
      where: { state: { in: [...RESOLVED_STATES] }, rootCauseCiId: { not: null }, validations: { none: {} } },
      distinct: ['tenantId'],
      select: { tenantId: true },
    });
    return rows.map((r) => r.tenantId);
  }

  async pending(tenantId: string, limit: number): Promise<IncidentToValidate[]> {
    const rows = await this.prisma.client.incident.findMany({ where: this.pendingWhere(tenantId), orderBy: [{ resolvedAt: 'asc' }, { id: 'asc' }], take: limit, select: INCIDENT_SELECT });
    return rows.map(toIncident).filter((i): i is IncidentToValidate => i !== null);
  }

  async incident(tenantId: string, id: string): Promise<IncidentToValidate | null> {
    const row = await this.prisma.client.incident.findFirst({ where: { id, tenantId, state: { in: [...RESOLVED_STATES] } }, select: INCIDENT_SELECT });
    return row === null ? null : toIncident(row);
  }

  async priorSimulationId(tenantId: string, rootCauseCiId: string, before: string): Promise<string | null> {
    const row = await this.prisma.client.impactSimulation.findFirst({
      where: { tenantId, failedCiIds: { equals: [rootCauseCiId] }, ranAt: { lte: new Date(before) }, scenario: { origin: 'user' } },
      orderBy: { ranAt: 'desc' },
      select: { id: true },
    });
    return row?.id ?? null;
  }

  async saveValidation(tx: Prisma.TransactionClient, v: NewValidation): Promise<ValidationRecord> {
    const data = {
      predictedServiceCiIds: v.predictedServiceCiIds,
      actualServiceCiIds: v.actualServiceCiIds,
      missedServiceCiIds: v.missedServiceCiIds,
      accuracy: v.accuracy,
      validatedAt: new Date(v.validatedAt),
    };
    // One current validation per incident: validating it again (another simulation) replaces the earlier one.
    const row = await tx.impactValidation.upsert({
      where: { incidentId: v.incidentId },
      create: { tenantId: v.tenantId, simulationId: v.simulationId, incidentId: v.incidentId, ...data },
      update: { simulationId: v.simulationId, ...data },
    });
    return toValidation(row);
  }

  async suggest(tx: Prisma.TransactionClient, tenantId: string, type: RelationshipType, fromCiId: string, toCiId: string, incidentId: string): Promise<void> {
    const key = { tenantId_fromCiId_toCiId_type: { tenantId, fromCiId, toCiId, type } };
    const existing = await tx.relationshipSuggestion.findUnique({ where: key, select: { state: true } });
    if (existing === null) {
      await tx.relationshipSuggestion.create({ data: { tenantId, type, fromCiId, toCiId, reason: IMPACT.suggestionReason, lastIncidentId: incidentId } });
      return;
    }
    if (existing.state !== 'open') return;
    await tx.relationshipSuggestion.update({ where: key, data: { occurrences: { increment: 1 }, lastIncidentId: incidentId } });
  }

  async existingPairs(tenantId: string, type: RelationshipType, fromCiId: string, toCiIds: readonly string[]): Promise<Set<string>> {
    if (toCiIds.length === 0) return new Set();
    const rows = await this.prisma.client.relationship.findMany({
      where: { tenantId, type, fromCiId, toCiId: { in: [...toCiIds] }, validTo: null },
      select: { toCiId: true },
    });
    return new Set(rows.map((r) => r.toCiId));
  }

  async counts(tenantId: string): Promise<AccuracyCounts> {
    const [aggregate, exact, pending, withoutRootCause] = await Promise.all([
      this.prisma.client.impactValidation.aggregate({ where: { tenantId }, _count: { _all: true }, _avg: { accuracy: true } }),
      this.prisma.client.impactValidation.count({ where: { tenantId, accuracy: { gte: 1 } } }),
      this.prisma.client.incident.count({ where: this.pendingWhere(tenantId) }),
      this.prisma.client.incident.count({ where: { tenantId, state: { in: [...RESOLVED_STATES] }, rootCauseCiId: null } }),
    ]);
    return { validated: aggregate._count._all, meanAccuracy: aggregate._avg.accuracy, exact, pending, withoutRootCause };
  }

  async recent(tenantId: string, limit: number): Promise<ValidationRecord[]> {
    const rows = await this.prisma.client.impactValidation.findMany({ where: { tenantId }, orderBy: [{ validatedAt: 'desc' }, { id: 'asc' }], take: limit });
    return rows.map(toValidation);
  }

  async suggestions(tenantId: string, state: SuggestionState, limit: number): Promise<RelationshipSuggestion[]> {
    const rows = await this.prisma.client.relationshipSuggestion.findMany({ where: { tenantId, state }, orderBy: [{ occurrences: 'desc' }, { updatedAt: 'desc' }], take: limit });
    return rows.map(toSuggestion);
  }

  async suggestion(tenantId: string, id: string): Promise<RelationshipSuggestion | null> {
    const row = await this.prisma.client.relationshipSuggestion.findFirst({ where: { id, tenantId } });
    return row === null ? null : toSuggestion(row);
  }

  async decide(tenantId: string, id: string, state: Exclude<SuggestionState, 'open'>, by: string, at: string, relationshipId: string | null): Promise<RelationshipSuggestion> {
    const row = await this.prisma.client.relationshipSuggestion.update({
      where: { id, tenantId },
      data: { state, decidedBy: by, decidedAt: new Date(at), relationshipId },
    });
    return toSuggestion(row);
  }
}
