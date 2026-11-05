// REQ-BSM-006 — SLA persistence (ADR-024): the SLA catalogue, the one-per-service assignment, and the SLA each service
// is held to. Interface plus Prisma implementation.
import { Injectable, NotFoundException } from '@nestjs/common';
import { slaDefinitionOf } from '@openmap/bsm-engine';
import { SLA } from '@openmap/constants';
import type { Prisma, PrismaClient } from '@openmap/db';
import { isoOf } from '../common/time.js';
import { PrismaService } from '../db/prisma.service.js';
import type { SlaInput } from './services.schemas.js';
import type { SlaRecord } from './services.types.js';

export const SLA_REPOSITORY = Symbol('SLA_REPOSITORY');

export interface SlaRepository {
  list(tenantId: string): Promise<SlaRecord[]>;
  byId(tenantId: string, id: string): Promise<SlaRecord | null>;
  upsert(
    tx: Prisma.TransactionClient,
    tenantId: string,
    id: string | null,
    input: SlaInput,
    actor: string,
  ): Promise<SlaRecord>;
  remove(tx: Prisma.TransactionClient, tenantId: string, id: string): Promise<void>;
  /** Holds the service to `slaId`; null clears the assignment. */
  assign(
    tx: Prisma.TransactionClient,
    tenantId: string,
    serviceCiId: string,
    slaId: string | null,
    actor: string,
  ): Promise<void>;
  /** The SLA of each listed service that has one. */
  assignedTo(tenantId: string, serviceCiIds: readonly string[]): Promise<Map<string, SlaRecord>>;
}

type SlaRow = Awaited<ReturnType<PrismaClient['sla']['findFirstOrThrow']>> & {
  assignments: Array<{ serviceCiId: string }>;
};

const WITH_ASSIGNMENTS = { assignments: { select: { serviceCiId: true } } } as const;

function toRecord(row: SlaRow): SlaRecord {
  const definition = slaDefinitionOf(row);
  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    description: row.description,
    availabilityTargetPercent: row.availabilityTargetPercent,
    window: row.window,
    ownTargets: definition.responseTargets,
    burnRateAlert: row.burnRateAlert,
    serviceCiIds: row.assignments.map((a) => a.serviceCiId),
    createdBy: row.createdBy,
    createdAt: isoOf(row.createdAt),
    updatedAt: isoOf(row.updatedAt),
  };
}

function targetsJson(input: SlaInput): Prisma.InputJsonObject {
  const out: Record<string, { respondMinutes: number; resolveMinutes: number }> = {};
  for (const t of input.responseTargets ?? [])
    out[t.severity] = { respondMinutes: t.respondMinutes, resolveMinutes: t.resolveMinutes };
  return out;
}

@Injectable()
export class PrismaSlaRepository implements SlaRepository {
  constructor(private readonly prisma: PrismaService) {}

  async list(tenantId: string): Promise<SlaRecord[]> {
    const rows = await this.prisma.client.sla.findMany({
      where: { tenantId },
      include: WITH_ASSIGNMENTS,
      orderBy: { name: 'asc' },
    });
    return rows.map(toRecord);
  }

  async byId(tenantId: string, id: string): Promise<SlaRecord | null> {
    const row = await this.prisma.client.sla.findFirst({
      where: { tenantId, id },
      include: WITH_ASSIGNMENTS,
    });
    return row ? toRecord(row) : null;
  }

  async upsert(
    tx: Prisma.TransactionClient,
    tenantId: string,
    id: string | null,
    input: SlaInput,
    actor: string,
  ): Promise<SlaRecord> {
    const data = {
      name: input.name,
      description: input.description ?? '',
      availabilityTargetPercent: input.availabilityTargetPercent,
      window: input.window,
      responseTargets: targetsJson(input),
      burnRateAlert: input.burnRateAlert ?? SLA.defaultBurnRateAlert,
    };
    if (id === null) {
      const row = await tx.sla.create({
        data: { tenantId, createdBy: actor, ...data },
        include: WITH_ASSIGNMENTS,
      });
      return toRecord(row);
    }
    const existing = await tx.sla.findFirst({ where: { tenantId, id } });
    if (!existing) throw new NotFoundException('sla ' + id + ' not found');
    const row = await tx.sla.update({ where: { id }, data, include: WITH_ASSIGNMENTS });
    return toRecord(row);
  }

  async remove(tx: Prisma.TransactionClient, tenantId: string, id: string): Promise<void> {
    const existing = await tx.sla.findFirst({ where: { tenantId, id } });
    if (!existing) throw new NotFoundException('sla ' + id + ' not found');
    await tx.sla.delete({ where: { id } });
  }

  async assign(
    tx: Prisma.TransactionClient,
    tenantId: string,
    serviceCiId: string,
    slaId: string | null,
    actor: string,
  ): Promise<void> {
    if (slaId === null) {
      await tx.serviceSlaAssignment.deleteMany({ where: { tenantId, serviceCiId } });
      return;
    }
    const sla = await tx.sla.findFirst({ where: { tenantId, id: slaId } });
    if (!sla) throw new NotFoundException('sla ' + slaId + ' not found');
    await tx.serviceSlaAssignment.upsert({
      where: { tenantId_serviceCiId: { tenantId, serviceCiId } },
      create: { tenantId, serviceCiId, slaId, assignedBy: actor },
      update: { slaId, assignedBy: actor, assignedAt: new Date() },
    });
  }

  async assignedTo(tenantId: string, serviceCiIds: readonly string[]): Promise<Map<string, SlaRecord>> {
    if (serviceCiIds.length === 0) return new Map();
    const rows = await this.prisma.client.serviceSlaAssignment.findMany({
      where: { tenantId, serviceCiId: { in: [...serviceCiIds] } },
      include: { sla: { include: WITH_ASSIGNMENTS } },
    });
    return new Map(rows.map((r) => [r.serviceCiId, toRecord(r.sla)]));
  }
}
