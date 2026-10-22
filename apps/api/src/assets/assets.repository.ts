// REQ-CMDB-002 — asset, plan, BOM, support-contract and vendor-contact persistence. Interface plus
// Prisma implementation; createPlan writes the plan, its lines and `quantity` planned assets per line.
import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type PrismaClient } from '@openmap/db';
import { NO_CURRENCY, toMoney } from '../common/money.js';
import { isoOf, toIso } from '../common/time.js';
import { asRecord, stringAttribute } from '../common/validation.js';
import { PrismaService } from '../db/prisma.service.js';
import type { PlanInput } from './assets.schemas.js';
import type { AssetRecordView, AssetStage, InfraPlanView, PlanStatus, SupportContractView, VendorContactView } from './assets.types.js';

export const ASSETS_REPOSITORY = Symbol('ASSETS_REPOSITORY');

export interface AssetsQuery {
  stages: readonly AssetStage[];
  /** Only assets whose warranty ends before this instant (ISO). */
  warrantyEndsBefore: string | null;
  first: number;
  afterId: string | null;
}

export interface AssetsRepository {
  assets(tenantId: string, query: AssetsQuery): Promise<AssetRecordView[]>;
  asset(tenantId: string, id: string): Promise<AssetRecordView | null>;
  assetsByCiIds(tenantId: string, ciIds: readonly string[]): Promise<AssetRecordView[]>;
  assetsByPlan(tenantId: string, planId: string): Promise<AssetRecordView[]>;
  plans(tenantId: string, statuses: readonly PlanStatus[]): Promise<InfraPlanView[]>;
  plan(tenantId: string, id: string): Promise<InfraPlanView | null>;
  planCount(tx: Prisma.TransactionClient, tenantId: string): Promise<number>;
  createPlan(tx: Prisma.TransactionClient, tenantId: string, owner: string, number: string, input: PlanInput): Promise<{ plan: InfraPlanView; assetIds: string[] }>;
  setPlanStatus(tx: Prisma.TransactionClient, tenantId: string, id: string, status: PlanStatus): Promise<InfraPlanView>;
  setAssetStage(tx: Prisma.TransactionClient, tenantId: string, id: string, stage: AssetStage, actor: string, note: string | null, at: string): Promise<AssetRecordView>;
  supportContract(tenantId: string, id: string): Promise<SupportContractView | null>;
  vendorContact(tenantId: string, id: string): Promise<VendorContactView | null>;
}

type AssetRow = Awaited<ReturnType<PrismaClient['assetRecord']['findUniqueOrThrow']>>;
const PLAN_INCLUDE = { bom: { orderBy: { position: 'asc' } } } as const satisfies Prisma.InfraPlanInclude;
type PlanRow = Prisma.InfraPlanGetPayload<{ include: typeof PLAN_INCLUDE }>;

export function toAsset(row: AssetRow): AssetRecordView {
  const warranty = row.warranty === null ? null : asRecord(row.warranty);
  const eol = row.endOfLife === null ? null : asRecord(row.endOfLife);
  return {
    id: row.id,
    ciId: row.ciId,
    assetTag: row.assetTag,
    serialNumber: row.serialNumber,
    manufacturer: row.manufacturer,
    model: row.model,
    stage: row.stage,
    warrantyEndsAt: warranty ? toIso(stringAttribute(warranty, 'endsAt')) : null,
    supportContractId: row.supportContractId,
    endOfSupport: eol ? toIso(stringAttribute(eol, 'endOfSupport')) : null,
    planId: row.planId,
    purchaseCost: toMoney(row.purchaseCostAmount, row.purchaseCostCurrency),
  };
}

export function toPlan(row: PlanRow): InfraPlanView {
  return {
    id: row.id,
    number: row.number,
    name: row.name,
    kind: row.kind,
    status: row.status,
    bom: row.bom.map((l) => ({ description: l.description, manufacturer: l.manufacturer, model: l.model, sku: l.sku, layer: l.layer, quantity: l.quantity, received: l.received, unitCost: toMoney(l.unitCostAmount, l.unitCostCurrency) })),
    estimatedCost: toMoney(row.estimatedCostAmount, row.estimatedCostCurrency),
    targetSiteCiId: row.targetSiteCiId,
    targetRackCiIds: row.targetRackCiIds,
    plannedLiveAt: toIso(row.plannedLiveAt),
  };
}

/** Sum of quantity × unit cost when every priced line shares one currency; null otherwise. */
export function estimatedCostOf(bom: PlanInput['bom']): { amount: number; currency: string } | null {
  const priced = bom.filter((l) => l.unitCostAmount !== null && l.unitCostAmount !== undefined && l.unitCostCurrency);
  if (priced.length === 0) return null;
  const currencies = new Set(priced.map((l) => l.unitCostCurrency));
  if (currencies.size !== 1) return null;
  const [currency] = currencies;
  return { amount: priced.reduce((sum, l) => sum + (l.unitCostAmount ?? 0) * l.quantity, 0), currency: currency ?? NO_CURRENCY };
}

@Injectable()
export class PrismaAssetsRepository implements AssetsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async assets(tenantId: string, q: AssetsQuery): Promise<AssetRecordView[]> {
    const where: Prisma.AssetRecordWhereInput = { tenantId };
    if (q.stages.length > 0) where.stage = { in: [...q.stages] };
    if (q.warrantyEndsBefore !== null) where.warranty = { path: ['endsAt'], lte: q.warrantyEndsBefore };
    if (q.afterId !== null) where.id = { gt: q.afterId };
    const rows = await this.prisma.client.assetRecord.findMany({ where, orderBy: { id: 'asc' }, take: q.first });
    return rows.map(toAsset);
  }

  async asset(tenantId: string, id: string): Promise<AssetRecordView | null> {
    const row = await this.prisma.client.assetRecord.findFirst({ where: { id, tenantId } });
    return row ? toAsset(row) : null;
  }

  async assetsByCiIds(tenantId: string, ciIds: readonly string[]): Promise<AssetRecordView[]> {
    if (ciIds.length === 0) return [];
    const rows = await this.prisma.client.assetRecord.findMany({ where: { tenantId, ciId: { in: [...ciIds] } }, orderBy: { id: 'asc' } });
    return rows.map(toAsset);
  }

  async assetsByPlan(tenantId: string, planId: string): Promise<AssetRecordView[]> {
    const rows = await this.prisma.client.assetRecord.findMany({ where: { tenantId, planId }, orderBy: { assetTag: 'asc' } });
    return rows.map(toAsset);
  }

  async plans(tenantId: string, statuses: readonly PlanStatus[]): Promise<InfraPlanView[]> {
    const where: Prisma.InfraPlanWhereInput = { tenantId };
    if (statuses.length > 0) where.status = { in: [...statuses] };
    const rows = await this.prisma.client.infraPlan.findMany({ where, include: PLAN_INCLUDE, orderBy: { createdAt: 'desc' } });
    return rows.map(toPlan);
  }

  async plan(tenantId: string, id: string): Promise<InfraPlanView | null> {
    const row = await this.prisma.client.infraPlan.findFirst({ where: { id, tenantId }, include: PLAN_INCLUDE });
    return row ? toPlan(row) : null;
  }

  planCount(tx: Prisma.TransactionClient, tenantId: string): Promise<number> {
    return tx.infraPlan.count({ where: { tenantId } });
  }

  async createPlan(tx: Prisma.TransactionClient, tenantId: string, owner: string, number: string, input: PlanInput): Promise<{ plan: InfraPlanView; assetIds: string[] }> {
    const estimated = estimatedCostOf(input.bom);
    const plan = await tx.infraPlan.create({
      data: {
        tenantId,
        number,
        name: input.name,
        description: input.description,
        kind: input.kind,
        status: 'draft',
        owner,
        targetSiteCiId: input.targetSiteId ?? null,
        targetRackCiIds: input.targetRackIds ?? [],
        estimatedCostAmount: estimated?.amount ?? null,
        estimatedCostCurrency: estimated?.currency ?? null,
        externalRefs: [],
        plannedLiveAt: input.plannedLiveAt ? new Date(input.plannedLiveAt) : null,
        bom: {
          create: input.bom.map((l, position) => ({
            tenantId,
            position,
            description: l.description,
            manufacturer: l.manufacturer ?? null,
            model: l.model ?? null,
            sku: l.sku ?? null,
            layer: l.layer,
            quantity: l.quantity,
            unitCostAmount: l.unitCostAmount ?? null,
            unitCostCurrency: l.unitCostCurrency ?? null,
          })),
        },
      },
      include: PLAN_INCLUDE,
    });
    const planCurrency = estimated?.currency ?? input.bom.find((l) => l.unitCostCurrency)?.unitCostCurrency ?? NO_CURRENCY;
    const now = new Date();
    const assetIds: string[] = [];
    for (const [position, line] of input.bom.entries()) {
      for (let unit = 0; unit < line.quantity; unit++) {
        const asset = await tx.assetRecord.create({
          data: {
            tenantId,
            planId: plan.id,
            assetTag: number + '-' + String(position + 1) + '-' + String(unit + 1),
            manufacturer: line.manufacturer ?? line.description,
            model: line.model ?? line.sku ?? line.description,
            partNumber: line.sku ?? null,
            stage: 'planned',
            stageChangedAt: now,
            purchaseCostAmount: line.unitCostAmount ?? null,
            purchaseCostCurrency: line.unitCostCurrency ?? null,
            // Depreciation starts when the asset is deployed; a planned asset has no schedule yet,
            // so the useful life is the one-month minimum the schema requires and residual value is zero.
            depreciationMethod: 'none',
            usefulLifeMonths: 1,
            residualValueAmount: 0,
            residualValueCurrency: line.unitCostCurrency ?? planCurrency,
            tags: [],
            customFields: {},
          },
        });
        await tx.assetAudit.create({ data: { tenantId, assetId: asset.id, actor: owner, at: now, field: 'stage', fromValue: null, toValue: 'planned', note: 'created from plan ' + number } });
        assetIds.push(asset.id);
      }
    }
    return { plan: toPlan(plan), assetIds };
  }

  async setPlanStatus(tx: Prisma.TransactionClient, tenantId: string, id: string, status: PlanStatus): Promise<InfraPlanView> {
    const existing = await tx.infraPlan.findFirst({ where: { id, tenantId } });
    if (!existing) throw new NotFoundException('plan ' + id + ' not found');
    const row = await tx.infraPlan.update({ where: { id }, data: { status }, include: PLAN_INCLUDE });
    return toPlan(row);
  }

  async setAssetStage(tx: Prisma.TransactionClient, tenantId: string, id: string, stage: AssetStage, actor: string, note: string | null, at: string): Promise<AssetRecordView> {
    const existing = await tx.assetRecord.findFirst({ where: { id, tenantId } });
    if (!existing) throw new NotFoundException('asset ' + id + ' not found');
    const row = await tx.assetRecord.update({ where: { id }, data: { stage, stageChangedAt: new Date(at) } });
    await tx.assetAudit.create({ data: { tenantId, assetId: id, actor, at: new Date(at), field: 'stage', fromValue: existing.stage, toValue: stage, note } });
    return toAsset(row);
  }

  async supportContract(tenantId: string, id: string): Promise<SupportContractView | null> {
    const row = await this.prisma.client.supportContract.findFirst({ where: { id, tenantId } });
    return row ? { id: row.id, vendorCiId: row.vendorCiId, contractNumber: row.contractNumber, level: row.level, endsAt: isoOf(row.endsAt), primaryContactId: row.primaryContactId } : null;
  }

  async vendorContact(tenantId: string, id: string): Promise<VendorContactView | null> {
    const row = await this.prisma.client.vendorContact.findFirst({ where: { id, tenantId } });
    return row ? { id: row.id, name: row.name, role: row.role, email: row.email, phone: row.phone, portalUrl: row.portalUrl } : null;
  }
}
