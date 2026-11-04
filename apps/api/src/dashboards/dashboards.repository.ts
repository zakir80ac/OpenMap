// REQ-UI-030 — dashboard persistence (dashboards table), returning the contract shape (ADR-020).
import { Injectable } from '@nestjs/common';
import { dashboardSchema, type Dashboard, type DashboardInput, type DashboardWidget } from '@openmap/contracts';
import { Prisma, type PrismaClient } from '@openmap/db';
import { randomUUID } from 'node:crypto';
import { isoOf } from '../common/time.js';
import { PrismaService } from '../db/prisma.service.js';

export const DASHBOARDS_REPOSITORY = Symbol('DASHBOARDS_REPOSITORY');

export interface DashboardsRepository {
  /** Every dashboard the user may read: their own plus the tenant's shared ones, default first, then newest. */
  visible(tenantId: string, owner: string): Promise<Dashboard[]>;
  byId(tenantId: string, id: string): Promise<Dashboard | null>;
  countOwned(tenantId: string, owner: string): Promise<number>;
  create(tenantId: string, owner: string, input: DashboardInput, isDefault: boolean): Promise<Dashboard>;
  update(tenantId: string, id: string, input: DashboardInput): Promise<Dashboard>;
  remove(tenantId: string, id: string): Promise<void>;
  /** Makes one dashboard the owner's default and clears the flag on the owner's others, in one transaction. */
  setDefault(tenantId: string, owner: string, id: string): Promise<Dashboard>;
}

type Row = Awaited<ReturnType<PrismaClient['dashboard']['findUniqueOrThrow']>>;

function toDashboard(row: Row): Dashboard {
  return dashboardSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    persona: row.persona,
    owner: row.owner,
    shared: row.shared,
    isDefault: row.isDefault,
    widgets: row.widgets,
    createdAt: isoOf(row.createdAt),
    updatedAt: isoOf(row.updatedAt),
  });
}

/** Widgets get a stable id on write so the console can key, reorder and audit them. */
function withIds(input: DashboardInput): DashboardWidget[] {
  return input.widgets.map((w) => ({ id: randomUUID(), kind: w.kind, size: w.size, options: w.options }));
}

@Injectable()
export class PrismaDashboardsRepository implements DashboardsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async visible(tenantId: string, owner: string): Promise<Dashboard[]> {
    const rows = await this.prisma.client.dashboard.findMany({
      where: { tenantId, OR: [{ owner }, { shared: true }] },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    });
    return rows.map(toDashboard);
  }

  async byId(tenantId: string, id: string): Promise<Dashboard | null> {
    const row = await this.prisma.client.dashboard.findFirst({ where: { id, tenantId } });
    return row ? toDashboard(row) : null;
  }

  countOwned(tenantId: string, owner: string): Promise<number> {
    return this.prisma.client.dashboard.count({ where: { tenantId, owner } });
  }

  async create(tenantId: string, owner: string, input: DashboardInput, isDefault: boolean): Promise<Dashboard> {
    const row = await this.prisma.client.dashboard.create({
      data: { tenantId, owner, name: input.name, persona: input.persona, shared: input.shared, isDefault, widgets: withIds(input) as unknown as Prisma.InputJsonArray },
    });
    return toDashboard(row);
  }

  async update(tenantId: string, id: string, input: DashboardInput): Promise<Dashboard> {
    const row = await this.prisma.client.dashboard.update({
      where: { id, tenantId },
      data: { name: input.name, persona: input.persona, shared: input.shared, widgets: withIds(input) as unknown as Prisma.InputJsonArray },
    });
    return toDashboard(row);
  }

  async remove(tenantId: string, id: string): Promise<void> {
    await this.prisma.client.dashboard.delete({ where: { id, tenantId } });
  }

  async setDefault(tenantId: string, owner: string, id: string): Promise<Dashboard> {
    const row = await this.prisma.client.$transaction(async (tx) => {
      await tx.dashboard.updateMany({ where: { tenantId, owner, isDefault: true }, data: { isDefault: false } });
      return tx.dashboard.update({ where: { id, tenantId }, data: { isDefault: true } });
    });
    return toDashboard(row);
  }
}
