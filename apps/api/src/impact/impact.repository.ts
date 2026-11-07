// REQ-BSM-003 REQ-BSM-004 — scenario and simulation persistence (impact_scenarios, impact_simulations), returning
// the contract shapes the BSM engine consumes. Interface plus Prisma implementation. The saved list holds the people's
// what-if scenarios only; incident replays (origin `incident`, ADR-047) are reached through their validation.
import { Injectable, NotFoundException } from '@nestjs/common';
import { impactScenarioSchema, impactSimulationSchema, type ImpactScenario, type ImpactSimulation, type ScenarioOrigin } from '@openmap/contracts';
import { Prisma, type PrismaClient } from '@openmap/db';
import { isoDateOf, isoOf, toIso } from '../common/time.js';
import { PrismaService } from '../db/prisma.service.js';
import type { ScenarioInput } from './impact.schemas.js';

export const IMPACT_REPOSITORY = Symbol('IMPACT_REPOSITORY');

export interface ImpactRepository {
  scenarios(tenantId: string): Promise<ImpactScenario[]>;
  scenario(tenantId: string, id: string): Promise<ImpactScenario | null>;
  saveScenario(tx: Prisma.TransactionClient, tenantId: string, createdBy: string, input: ScenarioInput, origin?: ScenarioOrigin): Promise<ImpactScenario>;
  simulation(tenantId: string, id: string): Promise<ImpactSimulation | null>;
  saveSimulation(tx: Prisma.TransactionClient, simulation: ImpactSimulation): Promise<ImpactSimulation>;
}

const WITH_RUNBOOK = { runbook: true } as const;
type ScenarioRow = Prisma.ImpactScenarioGetPayload<{ include: typeof WITH_RUNBOOK }>;
type SimulationRow = Awaited<ReturnType<PrismaClient['impactSimulation']['findUniqueOrThrow']>>;

function toScenario(row: ScenarioRow): ImpactScenario {
  return impactScenarioSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    kind: row.kind,
    origin: row.origin,
    failedCiIds: row.failedCiIds,
    options: { maxDepth: row.maxDepth, honourRedundancy: row.honourRedundancy, includeSharedServices: row.includeSharedServices, at: toIso(row.evaluatedAt) },
    createdBy: row.createdBy,
    createdAt: isoOf(row.createdAt),
    changeRef: row.changeRefSource !== null && row.changeRefId !== null ? { source: row.changeRefSource, id: row.changeRefId } : null,
    runbook:
      row.runbook === null
        ? null
        : { code: row.runbook.code, title: row.runbook.title, ownerTeam: row.runbook.ownerTeam, steps: row.runbook.steps, lastReviewedAt: row.runbook.lastReviewedAt === null ? null : isoDateOf(row.runbook.lastReviewedAt) },
  });
}

function toSimulation(row: SimulationRow): ImpactSimulation {
  return impactSimulationSchema.parse({
    id: row.id,
    scenarioId: row.scenarioId,
    tenantId: row.tenantId,
    ranAt: isoOf(row.ranAt),
    durationMs: row.durationMs,
    failedCiIds: row.failedCiIds,
    affectedApplicationCiIds: row.affectedApplicationCiIds,
    services: row.services,
    totals: {
      servicesDown: row.servicesDown,
      servicesDegraded: row.servicesDegraded,
      usersAffected: row.usersAffected,
      revenueAtRiskPerHour: row.revenueAtRiskAmount !== null && row.revenueAtRiskCurrency !== null ? { amount: Number(row.revenueAtRiskAmount.toString()), currency: row.revenueAtRiskCurrency } : null,
    },
    recommendations: row.recommendations,
  });
}

@Injectable()
export class PrismaImpactRepository implements ImpactRepository {
  constructor(private readonly prisma: PrismaService) {}

  async scenarios(tenantId: string): Promise<ImpactScenario[]> {
    const rows = await this.prisma.client.impactScenario.findMany({ where: { tenantId, origin: 'user' }, orderBy: { createdAt: 'desc' }, include: WITH_RUNBOOK });
    return rows.map(toScenario);
  }

  async scenario(tenantId: string, id: string): Promise<ImpactScenario | null> {
    const row = await this.prisma.client.impactScenario.findFirst({ where: { id, tenantId }, include: WITH_RUNBOOK });
    return row ? toScenario(row) : null;
  }

  async saveScenario(tx: Prisma.TransactionClient, tenantId: string, createdBy: string, input: ScenarioInput, origin: ScenarioOrigin = 'user'): Promise<ImpactScenario> {
    const row = await tx.impactScenario.create({
      data: {
        tenantId,
        name: input.name,
        kind: input.kind,
        origin,
        failedCiIds: input.failedCiIds,
        maxDepth: input.maxDepth ?? 0,
        honourRedundancy: input.honourRedundancy ?? true,
        includeSharedServices: input.includeSharedServices ?? true,
        evaluatedAt: input.at ? new Date(input.at) : null,
        runbookId: input.runbookId ?? null,
        createdBy,
      },
      include: WITH_RUNBOOK,
    });
    return toScenario(row);
  }

  async simulation(tenantId: string, id: string): Promise<ImpactSimulation | null> {
    const row = await this.prisma.client.impactSimulation.findFirst({ where: { id, tenantId } });
    return row ? toSimulation(row) : null;
  }

  async saveSimulation(tx: Prisma.TransactionClient, sim: ImpactSimulation): Promise<ImpactSimulation> {
    const scenario = await tx.impactScenario.findFirst({ where: { id: sim.scenarioId, tenantId: sim.tenantId } });
    if (!scenario) throw new NotFoundException('scenario ' + sim.scenarioId + ' not found');
    const row = await tx.impactSimulation.create({
      data: {
        id: sim.id,
        tenantId: sim.tenantId,
        scenarioId: sim.scenarioId,
        ranAt: new Date(sim.ranAt),
        durationMs: sim.durationMs,
        failedCiIds: sim.failedCiIds,
        affectedApplicationCiIds: sim.affectedApplicationCiIds,
        services: sim.services as unknown as Prisma.InputJsonArray,
        servicesDown: sim.totals.servicesDown,
        servicesDegraded: sim.totals.servicesDegraded,
        usersAffected: sim.totals.usersAffected,
        revenueAtRiskAmount: sim.totals.revenueAtRiskPerHour?.amount ?? null,
        revenueAtRiskCurrency: sim.totals.revenueAtRiskPerHour?.currency ?? null,
        recommendations: sim.recommendations as unknown as Prisma.InputJsonArray,
      },
    });
    return toSimulation(row);
  }
}
