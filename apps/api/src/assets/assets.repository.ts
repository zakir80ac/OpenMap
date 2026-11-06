// REQ-CMDB-002 REQ-CMDB-039 REQ-CMDB-040 — asset, plan, BOM, support-contract and vendor-contact persistence.
// Interface plus Prisma implementation; createPlan writes the plan, its lines and `quantity` planned assets per
// line; the register queries filter by layer, type, stage, source, text and data gap; detail entry audits each
// changed field; ensureAssetForCi gives a labelled CI its register row (ADR-023).
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ASSETS, MONEY } from '@openmap/constants';
import {
  type AssetDataGap,
  type AssetSource,
  type CiLayer,
  type CiType,
  type EndOfLife,
  SUBSCRIPTION_CI_TYPES,
  type Subscription,
  type Support,
  type Warranty,
  assetDataGaps,
  assetFieldsFromCi,
  belowReorderPoint,
  bookValue,
  canReceive,
  endOfLifeSchema,
  outstanding,
  subscriptionSchema,
  supportSchema,
  warrantySchema,
} from '@openmap/contracts';
import { Prisma, type PrismaClient } from '@openmap/db';
import type { CiRecord } from '../ci/ci.types.js';
import { NO_CURRENCY, toMoney, type Money } from '../common/money.js';
import { isoOf, nowIso, toIso } from '../common/time.js';
import { PrismaService } from '../db/prisma.service.js';
import type { AssetDetailsInput, ManualAssetInput, PlanInput, ReceiptInput } from './assets.schemas.js';
import type {
  AssetAuditView,
  AssetPageView,
  AssetRecordView,
  AssetStage,
  AssetSummaryView,
  EndOfLifeView,
  InfraPlanView,
  PlanReceiptView,
  PlanStatus,
  SubscriptionView,
  SupportContractView,
  SupportView,
  VendorContactView,
  WarrantyView,
} from './assets.types.js';

export const ASSETS_REPOSITORY = Symbol('ASSETS_REPOSITORY');

export interface AssetsQuery {
  layers: readonly CiLayer[];
  types: readonly CiType[];
  stages: readonly AssetStage[];
  sources: readonly AssetSource[];
  dataGaps: readonly AssetDataGap[];
  /** Matches the tag, serial, make, model or the CI's display name, case-insensitively. */
  text: string | null;
  /** Only assets whose warranty ends before this instant (ISO). */
  warrantyEndsBefore: string | null;
  /** REQ-CMDB-019: only stocked spares at or below their reorder point. */
  belowReorderPoint: boolean;
  first: number;
  afterId: string | null;
}

export interface AssetsRepository {
  assets(tenantId: string, query: AssetsQuery): Promise<AssetRecordView[]>;
  assetPage(tenantId: string, query: AssetsQuery, page: number, pageSize: number): Promise<AssetPageView>;
  asset(tenantId: string, id: string): Promise<AssetRecordView | null>;
  assetsByCiIds(tenantId: string, ciIds: readonly string[]): Promise<AssetRecordView[]>;
  assetsByPlan(tenantId: string, planId: string): Promise<AssetRecordView[]>;
  summary(tenantId: string, nowIso: string): Promise<AssetSummaryView[]>;
  audits(tenantId: string, assetId: string): Promise<AssetAuditView[]>;
  plans(tenantId: string, statuses: readonly PlanStatus[]): Promise<InfraPlanView[]>;
  plan(tenantId: string, id: string): Promise<InfraPlanView | null>;
  planCount(tx: Prisma.TransactionClient, tenantId: string): Promise<number>;
  createPlan(
    tx: Prisma.TransactionClient,
    tenantId: string,
    owner: string,
    number: string,
    input: PlanInput,
  ): Promise<{ plan: InfraPlanView; assetIds: string[] }>;
  setPlanStatus(
    tx: Prisma.TransactionClient,
    tenantId: string,
    id: string,
    status: PlanStatus,
  ): Promise<InfraPlanView>;
  setAssetStage(
    tx: Prisma.TransactionClient,
    tenantId: string,
    id: string,
    stage: AssetStage,
    actor: string,
    note: string | null,
    at: string,
  ): Promise<AssetRecordView>;
  updateDetails(
    tx: Prisma.TransactionClient,
    tenantId: string,
    id: string,
    input: AssetDetailsInput,
    actor: string,
    at: string,
  ): Promise<{ asset: AssetRecordView; changed: string[] }>;
  createManual(
    tx: Prisma.TransactionClient,
    tenantId: string,
    actor: string,
    ci: CiRecord,
    input: ManualAssetInput,
    at: string,
  ): Promise<AssetRecordView>;
  ensureForCi(
    tx: Prisma.TransactionClient,
    tenantId: string,
    actor: string,
    ci: CiRecord,
    layer: CiLayer,
    at: string,
  ): Promise<AssetRecordView>;
  supportContract(tenantId: string, id: string): Promise<SupportContractView | null>;
  vendorContact(tenantId: string, id: string): Promise<VendorContactView | null>;
  assetsByIds(tenantId: string, ids: readonly string[]): Promise<AssetRecordView[]>;
  receipts(tenantId: string, planId: string): Promise<PlanReceiptView[]>;
  receive(
    tx: Prisma.TransactionClient,
    tenantId: string,
    actor: string,
    input: ReceiptInput,
    at: string,
  ): Promise<ReceiveOutcome>;
}

/** What one receipt did: the receipt, the units it took into stock and the plan status before and after. */
export interface ReceiveOutcome {
  receipt: PlanReceiptView;
  assets: AssetRecordView[];
  outstanding: number;
  planNumber: string;
  previousStatus: PlanStatus;
  status: PlanStatus;
}

const RECEIPT_INCLUDE = { bomLine: { select: { position: true, description: true } } } as const satisfies Prisma.PlanReceiptInclude;
type ReceiptRow = Prisma.PlanReceiptGetPayload<{ include: typeof RECEIPT_INCLUDE }>;

function toReceipt(row: ReceiptRow): PlanReceiptView {
  return {
    id: row.id,
    planId: row.planId,
    bomLineId: row.bomLineId,
    position: row.bomLine.position,
    description: row.bomLine.description,
    quantity: row.quantity,
    receivedOn: isoOf(row.receivedOn),
    receivedBy: row.receivedBy,
    reference: row.reference,
    locationCiId: row.locationCiId,
    assetIds: row.assetIds,
    createdAt: isoOf(row.createdAt),
  };
}

type AssetRow = Awaited<ReturnType<PrismaClient['assetRecord']['findUniqueOrThrow']>>;
const PLAN_INCLUDE = { bom: { orderBy: { position: 'asc' } } } as const satisfies Prisma.InfraPlanInclude;
type PlanRow = Prisma.InfraPlanGetPayload<{ include: typeof PLAN_INCLUDE }>;
/** Stages that no longer count as owned property. */
const UNOWNED_STAGES: readonly AssetStage[] = ['disposed'];
const MANUAL_SOURCE = 'manual' as const;

function parseWarranty(value: Prisma.JsonValue | null): Warranty | null {
  const parsed = warrantySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
function parseSubscription(value: Prisma.JsonValue | null): Subscription | null {
  const parsed = subscriptionSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
function parseSupport(value: Prisma.JsonValue | null): Support | null {
  const parsed = supportSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
function parseEndOfLife(value: Prisma.JsonValue | null): EndOfLife | null {
  const parsed = endOfLifeSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** The DateTime scalar wants instants: calendar dates in the stored cover become UTC midnight. */
function warrantyView(w: Warranty): WarrantyView {
  return { ...w, startsAt: toIso(w.startsAt), endsAt: isoOf(w.endsAt) };
}
function subscriptionView(sub: Subscription): SubscriptionView {
  return {
    ...sub,
    startsAt: toIso(sub.startsAt),
    endsAt: toIso(sub.endsAt),
    credits: sub.credits === null ? null : { ...sub.credits },
  };
}
function supportView(s: Support): SupportView {
  return { ...s, endsAt: isoOf(s.endsAt) };
}
function endOfLifeView(e: EndOfLife): EndOfLifeView {
  return {
    ...e,
    endOfSale: toIso(e.endOfSale),
    endOfSoftwareMaintenance: toIso(e.endOfSoftwareMaintenance),
    endOfSupport: toIso(e.endOfSupport),
  };
}

/** REQ-CMDB-017: today's value under the row's schedule, in the purchase currency. */
function bookValueOf(row: AssetRow): Money | null {
  const cost = row.purchaseCostAmount === null ? null : Number(row.purchaseCostAmount);
  const value = bookValue(cost, row.purchasedAt === null ? null : isoOf(row.purchasedAt), { method: row.depreciationMethod, usefulLifeMonths: row.usefulLifeMonths, residualValue: Number(row.residualValueAmount) }, nowIso());
  return value === null ? null : { amount: value, currency: row.purchaseCostCurrency ?? row.residualValueCurrency };
}

export function toAsset(row: AssetRow): AssetRecordView {
  const warranty = parseWarranty(row.warranty);
  const subscription = parseSubscription(row.subscription);
  const support = parseSupport(row.support);
  const endOfLife = parseEndOfLife(row.endOfLife);
  return {
    id: row.id,
    ciId: row.ciId,
    ciType: row.ciType,
    layer: row.layer,
    source: row.source,
    assetTag: row.assetTag,
    serialNumber: row.serialNumber,
    manufacturer: row.manufacturer,
    model: row.model,
    partNumber: row.partNumber,
    stage: row.stage,
    stageChangedAt: isoOf(row.stageChangedAt),
    custodian: row.custodian,
    locationCiId: row.locationCiId,
    purchasedAt: toIso(row.purchasedAt),
    purchaseCost: toMoney(row.purchaseCostAmount, row.purchaseCostCurrency),
    depreciation: {
      method: row.depreciationMethod,
      usefulLifeMonths: row.usefulLifeMonths,
      residualValue: { amount: Number(row.residualValueAmount), currency: row.residualValueCurrency },
    },
    bookValue: bookValueOf(row),
    stock:
      row.stockOnHand === null || row.stockReorderPoint === null
        ? null
        : { onHand: row.stockOnHand, reorderPoint: row.stockReorderPoint, belowReorderPoint: belowReorderPoint({ onHand: row.stockOnHand, reorderPoint: row.stockReorderPoint }) },
    warranty: warranty ? warrantyView(warranty) : null,
    warrantyEndsAt: warranty ? toIso(warranty.endsAt) : null,
    subscription: subscription ? subscriptionView(subscription) : null,
    subscriptionEndsAt: subscription ? toIso(subscription.endsAt) : null,
    creditsRemaining: subscription?.credits?.remaining ?? null,
    support: support ? supportView(support) : null,
    supportContractId: row.supportContractId,
    supportEndsAt: support ? toIso(support.endsAt) : null,
    endOfLife: endOfLife ? endOfLifeView(endOfLife) : null,
    endOfSupport: endOfLife ? toIso(endOfLife.endOfSupport) : null,
    dataGaps: assetDataGaps({
      ciType: row.ciType,
      warranty,
      subscription,
      support,
      supportContractId: row.supportContractId,
      endOfLife,
    }),
    planId: row.planId,
    bomLineId: row.bomLineId,
  };
}

export function toPlan(row: PlanRow): InfraPlanView {
  return {
    id: row.id,
    number: row.number,
    name: row.name,
    description: row.description,
    kind: row.kind,
    status: row.status,
    owner: row.owner,
    bom: row.bom.map((l) => ({
      id: l.id,
      position: l.position,
      description: l.description,
      manufacturer: l.manufacturer,
      model: l.model,
      sku: l.sku,
      layer: l.layer,
      quantity: l.quantity,
      received: l.received,
      outstanding: outstanding(l),
      unitCost: toMoney(l.unitCostAmount, l.unitCostCurrency),
    })),
    estimatedCost: toMoney(row.estimatedCostAmount, row.estimatedCostCurrency),
    targetSiteCiId: row.targetSiteCiId,
    targetRackCiIds: row.targetRackCiIds,
    plannedLiveAt: toIso(row.plannedLiveAt),
  };
}

/** Sum of quantity × unit cost when every priced line shares one currency; null otherwise. */
export function estimatedCostOf(bom: PlanInput['bom']): { amount: number; currency: string } | null {
  const priced = bom.filter(
    (l) => l.unitCostAmount !== null && l.unitCostAmount !== undefined && l.unitCostCurrency,
  );
  if (priced.length === 0) return null;
  const currencies = new Set(priced.map((l) => l.unitCostCurrency));
  if (currencies.size !== 1) return null;
  const [currency] = currencies;
  return {
    amount: priced.reduce((sum, l) => sum + (l.unitCostAmount ?? 0) * l.quantity, 0),
    currency: currency ?? NO_CURRENCY,
  };
}

function dateOnly(value: Date | null): string | null {
  return value === null ? null : value.toISOString().slice(0, 'YYYY-MM-DD'.length);
}

function jsonText(value: Prisma.JsonValue | null): string | null {
  return value === null ? null : JSON.stringify(value);
}

interface FieldChange {
  field: string;
  from: string | null;
  to: string | null;
}

/**
 * The column values a details input sets, against the current row, with one audit entry per field that changes.
 * An omitted field is untouched; an explicit null clears it. Cover a person enters is stamped `manual` and verified now.
 */
/** The columns a details input may set; plain values, so the same object feeds a create and an update. */
type DetailsData = Partial<
  Pick<
    Prisma.AssetRecordUncheckedCreateInput,
    | 'manufacturer'
    | 'model'
    | 'serialNumber'
    | 'partNumber'
    | 'custodian'
    | 'purchasedAt'
    | 'purchaseCostAmount'
    | 'purchaseCostCurrency'
    | 'warranty'
    | 'subscription'
    | 'support'
    | 'endOfLife'
    | 'depreciationMethod'
    | 'usefulLifeMonths'
    | 'residualValueAmount'
    | 'residualValueCurrency'
    | 'stockOnHand'
    | 'stockReorderPoint'
  >
>;

export function detailsData(
  input: AssetDetailsInput,
  row: AssetRow | null,
  at: string,
): { data: DetailsData; changes: FieldChange[] } {
  const data: DetailsData = {};
  const changes: FieldChange[] = [];
  const set = (field: string, from: string | null, to: string | null): void => {
    if (from !== to) changes.push({ field, from, to });
  };
  const scalar = (field: 'manufacturer' | 'model' | 'serialNumber' | 'partNumber' | 'custodian'): void => {
    const value = input[field];
    if (value === undefined) return;
    data[field] = value;
    set(field, row?.[field] ?? null, value);
  };
  scalar('manufacturer');
  scalar('model');
  scalar('serialNumber');
  scalar('partNumber');
  scalar('custodian');
  if (input.purchasedAt !== undefined) {
    data.purchasedAt = input.purchasedAt === null ? null : new Date(input.purchasedAt);
    set('purchasedAt', dateOnly(row?.purchasedAt ?? null), input.purchasedAt);
  }
  if (input.purchaseCostAmount !== undefined) {
    const amount = input.purchaseCostAmount;
    const currency =
      amount === null ? null : (input.purchaseCostCurrency ?? row?.purchaseCostCurrency ?? NO_CURRENCY);
    data.purchaseCostAmount = amount;
    data.purchaseCostCurrency = currency;
    set(
      'purchaseCost',
      row?.purchaseCostAmount == null
        ? null
        : String(row.purchaseCostAmount) + ' ' + (row.purchaseCostCurrency ?? NO_CURRENCY),
      amount === null ? null : String(amount) + ' ' + (currency ?? NO_CURRENCY),
    );
  }
  if (input.depreciation !== undefined && input.depreciation !== null) {
    const d = input.depreciation;
    data.depreciationMethod = d.method;
    data.usefulLifeMonths = d.usefulLifeMonths;
    data.residualValueAmount = d.residualValueAmount;
    data.residualValueCurrency = input.purchaseCostCurrency ?? row?.purchaseCostCurrency ?? row?.residualValueCurrency ?? NO_CURRENCY;
    set(
      'depreciation',
      row === null ? null : row.depreciationMethod + ' ' + String(row.usefulLifeMonths) + 'm ' + String(row.residualValueAmount),
      d.method + ' ' + String(d.usefulLifeMonths) + 'm ' + String(d.residualValueAmount),
    );
  }
  if (input.stock !== undefined) {
    data.stockOnHand = input.stock === null ? null : input.stock.onHand;
    data.stockReorderPoint = input.stock === null ? null : input.stock.reorderPoint;
    set(
      'stock',
      row?.stockOnHand == null ? null : String(row.stockOnHand) + '/' + String(row.stockReorderPoint),
      input.stock === null ? null : String(input.stock.onHand) + '/' + String(input.stock.reorderPoint),
    );
  }
  if (input.warranty !== undefined) {
    const warranty: Warranty | null =
      input.warranty === null
        ? null
        : {
            provider: input.warranty.provider,
            level: input.warranty.level ?? null,
            startsAt: input.warranty.startsAt ?? null,
            endsAt: input.warranty.endsAt,
            source: MANUAL_SOURCE,
            verifiedAt: at,
          };
    data.warranty = warranty === null ? Prisma.DbNull : warranty;
    set('warranty', jsonText(row?.warranty ?? null), warranty === null ? null : JSON.stringify(warranty));
  }
  if (input.subscription !== undefined) {
    const subscription: Subscription | null =
      input.subscription === null
        ? null
        : {
            provider: input.subscription.provider,
            plan: input.subscription.plan ?? null,
            startsAt: input.subscription.startsAt ?? null,
            endsAt: input.subscription.endsAt ?? null,
            credits:
              input.subscription.creditsRemaining === null ||
              input.subscription.creditsRemaining === undefined
                ? null
                : {
                    remaining: input.subscription.creditsRemaining,
                    unit: input.subscription.creditsUnit ?? '',
                    currency: input.subscription.creditsCurrency ?? null,
                    asOf: at,
                  },
            source: MANUAL_SOURCE,
            verifiedAt: at,
          };
    data.subscription = subscription === null ? Prisma.DbNull : subscription;
    set(
      'subscription',
      jsonText(row?.subscription ?? null),
      subscription === null ? null : JSON.stringify(subscription),
    );
  }
  if (input.support !== undefined) {
    const support: Support | null =
      input.support === null
        ? null
        : {
            provider: input.support.provider,
            contractNumber: input.support.contractNumber ?? null,
            level: input.support.level ?? null,
            endsAt: input.support.endsAt,
            source: MANUAL_SOURCE,
            verifiedAt: at,
          };
    data.support = support === null ? Prisma.DbNull : support;
    set('support', jsonText(row?.support ?? null), support === null ? null : JSON.stringify(support));
  }
  if (input.endOfLife !== undefined) {
    const eol: EndOfLife | null =
      input.endOfLife === null
        ? null
        : {
            endOfSale: input.endOfLife.endOfSale ?? null,
            endOfSoftwareMaintenance: input.endOfLife.endOfSoftwareMaintenance ?? null,
            endOfSupport: input.endOfLife.endOfSupport ?? null,
            source: MANUAL_SOURCE,
            verifiedAt: at,
          };
    data.endOfLife = eol === null ? Prisma.DbNull : eol;
    set('endOfLife', jsonText(row?.endOfLife ?? null), eol === null ? null : JSON.stringify(eol));
  }
  return { data, changes };
}

function gapWhere(gap: AssetDataGap): Prisma.AssetRecordWhereInput {
  switch (gap) {
    case 'warranty':
      // Hardware asks for a warranty; a subscription type never does.
      return { warranty: { equals: Prisma.DbNull }, NOT: { ciType: { in: [...SUBSCRIPTION_CI_TYPES] } } };
    case 'subscription':
      return { subscription: { equals: Prisma.DbNull }, ciType: { in: [...SUBSCRIPTION_CI_TYPES] } };
    case 'support':
      return { AND: [{ support: { equals: Prisma.DbNull } }, { supportContractId: null }] };
    case 'end_of_life':
      return {
        OR: [
          { endOfLife: { equals: Prisma.DbNull } },
          { endOfLife: { path: ['endOfSupport'], equals: Prisma.AnyNull } },
        ],
      };
  }
}

@Injectable()
export class PrismaAssetsRepository implements AssetsRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** The register's filter as a Prisma predicate; the cursor (afterId) is added by `assets`, the page by `assetPage`. */
  private whereFor(tenantId: string, q: AssetsQuery): Prisma.AssetRecordWhereInput[] {
    const and: Prisma.AssetRecordWhereInput[] = [{ tenantId }];
    if (q.layers.length > 0) and.push({ layer: { in: [...q.layers] } });
    if (q.types.length > 0) and.push({ ciType: { in: [...q.types] } });
    if (q.stages.length > 0) and.push({ stage: { in: [...q.stages] } });
    if (q.sources.length > 0) and.push({ source: { in: [...q.sources] } });
    for (const gap of q.dataGaps) and.push(gapWhere(gap));
    if (q.text !== null) {
      const contains = { contains: q.text, mode: 'insensitive' as const };
      and.push({
        OR: [
          { assetTag: contains },
          { serialNumber: contains },
          { manufacturer: contains },
          { model: contains },
          { ci: { displayName: contains } },
        ],
      });
    }
    if (q.warrantyEndsBefore !== null)
      and.push({ warranty: { path: ['endsAt'], lte: q.warrantyEndsBefore } });
    if (q.belowReorderPoint)
      and.push({ stockOnHand: { not: null, lte: this.prisma.client.assetRecord.fields.stockReorderPoint } });
    return and;
  }

  async assets(tenantId: string, q: AssetsQuery): Promise<AssetRecordView[]> {
    const and = this.whereFor(tenantId, q);
    if (q.afterId !== null) and.push({ id: { gt: q.afterId } });
    const rows = await this.prisma.client.assetRecord.findMany({
      where: { AND: and },
      orderBy: { id: 'asc' },
      take: q.first,
    });
    return rows.map(toAsset);
  }

  /** REQ-CMDB-041 — one page by number with the total under the same filter (two statements, one round trip each). */
  async assetPage(tenantId: string, q: AssetsQuery, page: number, pageSize: number): Promise<AssetPageView> {
    const where = { AND: this.whereFor(tenantId, q) };
    const [rows, totalCount] = await Promise.all([
      this.prisma.client.assetRecord.findMany({
        where,
        orderBy: { id: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.client.assetRecord.count({ where }),
    ]);
    return {
      items: rows.map(toAsset),
      totalCount,
      page,
      pageSize,
      pageCount: Math.max(1, Math.ceil(totalCount / pageSize)),
    };
  }

  async asset(tenantId: string, id: string): Promise<AssetRecordView | null> {
    const row = await this.prisma.client.assetRecord.findFirst({ where: { id, tenantId } });
    return row ? toAsset(row) : null;
  }

  async assetsByCiIds(tenantId: string, ciIds: readonly string[]): Promise<AssetRecordView[]> {
    if (ciIds.length === 0) return [];
    const rows = await this.prisma.client.assetRecord.findMany({
      where: { tenantId, ciId: { in: [...ciIds] } },
      orderBy: { id: 'asc' },
    });
    return rows.map(toAsset);
  }

  async assetsByPlan(tenantId: string, planId: string): Promise<AssetRecordView[]> {
    const rows = await this.prisma.client.assetRecord.findMany({
      where: { tenantId, planId },
      orderBy: { assetTag: 'asc' },
    });
    return rows.map(toAsset);
  }

  /** One grouped statement: rows per layer, rows with a gap, and cover already ended as of `now`. */
  async summary(tenantId: string, nowIso: string): Promise<AssetSummaryView[]> {
    const today = nowIso.slice(0, 'YYYY-MM-DD'.length);
    const rows = await this.prisma.client.$queryRaw<
      Array<{
        layer: CiLayer;
        count: number;
        needsData: number;
        warrantyExpired: number;
        subscriptionExpired: number;
        supportExpired: number;
        endOfSupportPassed: number;
        belowReorderPoint: number;
      }>
    >(Prisma.sql`
      SELECT a.layer, count(*)::int AS "count",
        count(*) FILTER (WHERE (CASE WHEN a."ciType"::text = ANY(${[...SUBSCRIPTION_CI_TYPES]}::text[]) THEN a.subscription IS NULL ELSE a.warranty IS NULL END) OR (a.support IS NULL AND a."supportContractId" IS NULL) OR a."endOfLife" IS NULL OR a."endOfLife"->>'endOfSupport' IS NULL)::int AS "needsData",
        count(*) FILTER (WHERE (a.warranty->>'endsAt')::date < ${today}::date)::int AS "warrantyExpired",
        count(*) FILTER (WHERE (a.subscription->>'endsAt')::date < ${today}::date)::int AS "subscriptionExpired",
        count(*) FILTER (WHERE (a.support->>'endsAt')::date < ${today}::date OR sc."endsAt" < ${today}::date)::int AS "supportExpired",
        count(*) FILTER (WHERE (a."endOfLife"->>'endOfSupport')::date < ${today}::date)::int AS "endOfSupportPassed",
        count(*) FILTER (WHERE a."stockOnHand" IS NOT NULL AND a."stockOnHand" <= a."stockReorderPoint")::int AS "belowReorderPoint"
      FROM asset_records a LEFT JOIN support_contracts sc ON sc.id = a."supportContractId"
      WHERE a."tenantId" = ${tenantId}::uuid AND a.stage <> ALL(${[...UNOWNED_STAGES]}::"AssetStage"[])
      GROUP BY a.layer`);
    return rows.map((r) => ({
      layer: r.layer,
      count: Number(r.count),
      needsData: Number(r.needsData),
      warrantyExpired: Number(r.warrantyExpired),
      subscriptionExpired: Number(r.subscriptionExpired),
      supportExpired: Number(r.supportExpired),
      endOfSupportPassed: Number(r.endOfSupportPassed),
      belowReorderPoint: Number(r.belowReorderPoint),
    }));
  }

  async audits(tenantId: string, assetId: string): Promise<AssetAuditView[]> {
    const rows = await this.prisma.client.assetAudit.findMany({
      where: { tenantId, assetId },
      orderBy: { at: 'desc' },
    });
    return rows.map((r) => ({
      id: r.id,
      actor: r.actor,
      at: isoOf(r.at),
      field: r.field,
      fromValue: r.fromValue,
      toValue: r.toValue,
      note: r.note,
    }));
  }

  async plans(tenantId: string, statuses: readonly PlanStatus[]): Promise<InfraPlanView[]> {
    const where: Prisma.InfraPlanWhereInput = { tenantId };
    if (statuses.length > 0) where.status = { in: [...statuses] };
    const rows = await this.prisma.client.infraPlan.findMany({
      where,
      include: PLAN_INCLUDE,
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(toPlan);
  }

  async plan(tenantId: string, id: string): Promise<InfraPlanView | null> {
    const row = await this.prisma.client.infraPlan.findFirst({
      where: { id, tenantId },
      include: PLAN_INCLUDE,
    });
    return row ? toPlan(row) : null;
  }

  planCount(tx: Prisma.TransactionClient, tenantId: string): Promise<number> {
    return tx.infraPlan.count({ where: { tenantId } });
  }

  async createPlan(
    tx: Prisma.TransactionClient,
    tenantId: string,
    owner: string,
    number: string,
    input: PlanInput,
  ): Promise<{ plan: InfraPlanView; assetIds: string[] }> {
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
    const planCurrency =
      estimated?.currency ?? input.bom.find((l) => l.unitCostCurrency)?.unitCostCurrency ?? NO_CURRENCY;
    const now = new Date();
    const assetIds: string[] = [];
    for (const [position, line] of input.bom.entries()) {
      const bomLineId = plan.bom.find((l) => l.position === position)?.id ?? null;
      for (let unit = 0; unit < line.quantity; unit++) {
        const asset = await tx.assetRecord.create({
          data: {
            tenantId,
            planId: plan.id,
            bomLineId,
            layer: line.layer,
            source: 'plan',
            assetTag: number + '-' + String(position + 1) + '-' + String(unit + 1),
            manufacturer: line.manufacturer ?? null,
            model: line.model ?? line.sku ?? line.description,
            partNumber: line.sku ?? null,
            stage: 'planned',
            stageChangedAt: now,
            purchaseCostAmount: line.unitCostAmount ?? null,
            purchaseCostCurrency: line.unitCostCurrency ?? null,
            // Depreciation starts when the asset is deployed; a planned asset has no schedule yet,
            // so the useful life is the one-month minimum the schema requires and residual value is zero.
            depreciationMethod: 'none',
            usefulLifeMonths: ASSETS.defaultUsefulLifeMonths,
            residualValueAmount: 0,
            residualValueCurrency: line.unitCostCurrency ?? planCurrency,
            tags: [],
            customFields: {},
          },
        });
        await tx.assetAudit.create({
          data: {
            tenantId,
            assetId: asset.id,
            actor: owner,
            at: now,
            field: 'stage',
            fromValue: null,
            toValue: 'planned',
            note: 'created from plan ' + number,
          },
        });
        assetIds.push(asset.id);
      }
    }
    return { plan: toPlan(plan), assetIds };
  }

  async setPlanStatus(
    tx: Prisma.TransactionClient,
    tenantId: string,
    id: string,
    status: PlanStatus,
  ): Promise<InfraPlanView> {
    const existing = await tx.infraPlan.findFirst({ where: { id, tenantId } });
    if (!existing) throw new NotFoundException('plan ' + id + ' not found');
    const row = await tx.infraPlan.update({ where: { id }, data: { status }, include: PLAN_INCLUDE });
    return toPlan(row);
  }

  async assetsByIds(tenantId: string, ids: readonly string[]): Promise<AssetRecordView[]> {
    if (ids.length === 0) return [];
    const rows = await this.prisma.client.assetRecord.findMany({
      where: { tenantId, id: { in: [...ids] } },
      orderBy: { assetTag: 'asc' },
    });
    return rows.map(toAsset);
  }

  async receipts(tenantId: string, planId: string): Promise<PlanReceiptView[]> {
    const rows = await this.prisma.client.planReceipt.findMany({
      where: { tenantId, planId },
      include: RECEIPT_INCLUDE,
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toReceipt);
  }

  /**
   * REQ-CMDB-020 (ADR-034) — takes the line's oldest planned units into stock with the serials (and tags) given,
   * audits every change, counts them as received, records the receipt and moves an approved plan to building.
   */
  async receive(
    tx: Prisma.TransactionClient,
    tenantId: string,
    actor: string,
    input: ReceiptInput,
    at: string,
  ): Promise<ReceiveOutcome> {
    const plan = await tx.infraPlan.findFirst({ where: { id: input.planId, tenantId }, include: PLAN_INCLUDE });
    if (!plan) throw new NotFoundException('plan ' + input.planId + ' not found');
    if (!canReceive(plan.status))
      throw new ConflictException('plan ' + plan.number + ' is ' + plan.status + '; goods are received on an approved or building plan');
    const line = plan.bom.find((l) => l.position === input.position);
    if (!line) throw new NotFoundException('plan ' + plan.number + ' has no BOM line at position ' + String(input.position));
    const left = outstanding(line);
    if (input.units.length > left)
      throw new ConflictException(
        'line ' + String(input.position + 1) + ' of ' + plan.number + ' has ' + String(left) + ' units outstanding, ' + String(input.units.length) + ' received',
      );
    if (input.locationId) {
      const location = await tx.ci.findFirst({ where: { id: input.locationId, tenantId }, select: { id: true } });
      if (!location) throw new NotFoundException('location ' + input.locationId + ' not found');
    }
    const serials = input.units.map((u) => u.serialNumber);
    const serialHolder = await tx.assetRecord.findFirst({
      where: { tenantId, serialNumber: { in: serials } },
      select: { assetTag: true, serialNumber: true },
    });
    if (serialHolder)
      throw new ConflictException('serial ' + String(serialHolder.serialNumber) + ' is already in the register as ' + serialHolder.assetTag);
    const tags = input.units.map((u) => u.assetTag).filter((t): t is string => typeof t === 'string');
    if (tags.length > 0) {
      const tagHolder = await tx.assetRecord.findFirst({ where: { tenantId, assetTag: { in: tags } }, select: { assetTag: true } });
      if (tagHolder) throw new ConflictException('asset tag ' + tagHolder.assetTag + ' is already in use');
    }
    const planned = await tx.assetRecord.findMany({
      where: { tenantId, bomLineId: line.id, stage: 'planned' },
      orderBy: [{ createdAt: 'asc' }, { assetTag: 'asc' }],
      take: input.units.length,
    });
    if (planned.length < input.units.length)
      throw new ConflictException(
        'line ' + String(input.position + 1) + ' of ' + plan.number + ' has ' + String(planned.length) + ' planned units left to receive',
      );
    const when = new Date(at);
    const receivedOn = new Date(input.receivedOn);
    const reference = input.reference ?? null;
    const note = reference === null ? 'received' : 'received under ' + reference;
    const assets: AssetRecordView[] = [];
    for (const [index, unit] of input.units.entries()) {
      const before = planned[index];
      if (before === undefined) continue;
      const tag = unit.assetTag ?? before.assetTag;
      const purchasedAt = before.purchasedAt ?? receivedOn;
      const locationCiId = input.locationId ?? before.locationCiId;
      const row = await tx.assetRecord.update({
        where: { id: before.id },
        data: {
          stage: 'in_stock',
          stageChangedAt: when,
          serialNumber: unit.serialNumber,
          assetTag: tag,
          purchasedAt,
          locationCiId,
        },
      });
      const audit = (field: string, fromValue: string | null, toValue: string | null): Prisma.AssetAuditCreateManyInput => ({
        tenantId,
        assetId: before.id,
        actor,
        at: when,
        field,
        fromValue,
        toValue,
        note,
      });
      const audits = [audit('stage', before.stage, 'in_stock'), audit('serialNumber', before.serialNumber, unit.serialNumber)];
      if (tag !== before.assetTag) audits.push(audit('assetTag', before.assetTag, tag));
      if (before.purchasedAt === null) audits.push(audit('purchasedAt', null, input.receivedOn));
      if (locationCiId !== before.locationCiId) audits.push(audit('locationCiId', before.locationCiId, locationCiId));
      await tx.assetAudit.createMany({ data: audits });
      assets.push(toAsset(row));
    }
    await tx.bomLine.update({ where: { id: line.id }, data: { received: { increment: assets.length } } });
    const status: PlanStatus = plan.status === 'approved' ? 'building' : plan.status;
    if (status !== plan.status) await tx.infraPlan.update({ where: { id: plan.id }, data: { status } });
    const receipt = await tx.planReceipt.create({
      data: {
        tenantId,
        planId: plan.id,
        bomLineId: line.id,
        quantity: assets.length,
        receivedOn,
        receivedBy: actor,
        reference,
        locationCiId: input.locationId ?? null,
        assetIds: assets.map((a) => a.id),
      },
      include: RECEIPT_INCLUDE,
    });
    return {
      receipt: toReceipt(receipt),
      assets,
      outstanding: left - assets.length,
      planNumber: plan.number,
      previousStatus: plan.status,
      status,
    };
  }

  async setAssetStage(
    tx: Prisma.TransactionClient,
    tenantId: string,
    id: string,
    stage: AssetStage,
    actor: string,
    note: string | null,
    at: string,
  ): Promise<AssetRecordView> {
    const existing = await tx.assetRecord.findFirst({ where: { id, tenantId } });
    if (!existing) throw new NotFoundException('asset ' + id + ' not found');
    const row = await tx.assetRecord.update({ where: { id }, data: { stage, stageChangedAt: new Date(at) } });
    await tx.assetAudit.create({
      data: {
        tenantId,
        assetId: id,
        actor,
        at: new Date(at),
        field: 'stage',
        fromValue: existing.stage,
        toValue: stage,
        note,
      },
    });
    return toAsset(row);
  }

  async updateDetails(
    tx: Prisma.TransactionClient,
    tenantId: string,
    id: string,
    input: AssetDetailsInput,
    actor: string,
    at: string,
  ): Promise<{ asset: AssetRecordView; changed: string[] }> {
    const existing = await tx.assetRecord.findFirst({ where: { id, tenantId } });
    if (!existing) throw new NotFoundException('asset ' + id + ' not found');
    const { data, changes } = detailsData(input, existing, at);
    if (changes.length === 0) return { asset: toAsset(existing), changed: [] };
    const row = await tx.assetRecord.update({ where: { id }, data });
    await tx.assetAudit.createMany({
      data: changes.map((c) => ({
        tenantId,
        assetId: id,
        actor,
        at: new Date(at),
        field: c.field,
        fromValue: c.from,
        toValue: c.to,
        note: input.note ?? null,
      })),
    });
    return { asset: toAsset(row), changed: changes.map((c) => c.field) };
  }

  async createManual(
    tx: Prisma.TransactionClient,
    tenantId: string,
    actor: string,
    ci: CiRecord,
    input: ManualAssetInput,
    at: string,
  ): Promise<AssetRecordView> {
    const { data, changes } = detailsData(input.details, null, at);
    const when = new Date(at);
    const row = await tx.assetRecord.create({
      data: {
        tenantId,
        ciId: ci.id,
        ciType: ci.type,
        layer: input.layer,
        source: MANUAL_SOURCE,
        assetTag: input.assetTag ?? ci.code,
        stage: 'deployed',
        stageChangedAt: when,
        locationCiId: input.locationCiId ?? null,
        depreciationMethod: 'none',
        usefulLifeMonths: ASSETS.defaultUsefulLifeMonths,
        residualValueAmount: 0,
        residualValueCurrency: input.details.purchaseCostCurrency ?? MONEY.noCurrency,
        tags: [],
        customFields: {},
        ...data,
      },
    });
    await tx.assetAudit.createMany({
      data: [
        {
          tenantId,
          assetId: row.id,
          actor,
          at: when,
          field: 'stage',
          fromValue: null,
          toValue: 'deployed',
          note: 'entered manually',
        },
        ...changes.map((c) => ({
          tenantId,
          assetId: row.id,
          actor,
          at: when,
          field: c.field,
          fromValue: c.from,
          toValue: c.to,
          note: input.details.note ?? null,
        })),
      ],
    });
    return toAsset(row);
  }

  ensureForCi(
    tx: Prisma.TransactionClient,
    tenantId: string,
    actor: string,
    ci: CiRecord,
    layer: CiLayer,
    at: string,
  ): Promise<AssetRecordView> {
    return ensureAssetForCi(tx, tenantId, actor, ci, layer, at);
  }

  async supportContract(tenantId: string, id: string): Promise<SupportContractView | null> {
    const row = await this.prisma.client.supportContract.findFirst({ where: { id, tenantId } });
    return row
      ? {
          id: row.id,
          vendorCiId: row.vendorCiId,
          contractNumber: row.contractNumber,
          level: row.level,
          endsAt: isoOf(row.endsAt),
          primaryContactId: row.primaryContactId,
        }
      : null;
  }

  async vendorContact(tenantId: string, id: string): Promise<VendorContactView | null> {
    const row = await this.prisma.client.vendorContact.findFirst({ where: { id, tenantId } });
    return row
      ? {
          id: row.id,
          name: row.name,
          role: row.role,
          email: row.email,
          phone: row.phone,
          portalUrl: row.portalUrl,
        }
      : null;
  }
}

/**
 * The register row for a CI a person has just labelled: created from what the CI's attributes carry when none
 * exists (ADR-023), otherwise moved to the labelled layer. A standalone function so the CMDB service can call it
 * inside its own transaction without a module cycle.
 */
export async function ensureAssetForCi(
  tx: Prisma.TransactionClient,
  tenantId: string,
  actor: string,
  ci: CiRecord,
  layer: CiLayer,
  at: string,
): Promise<AssetRecordView> {
  const existing = await tx.assetRecord.findFirst({ where: { tenantId, ciId: ci.id } });
  if (existing) {
    if (existing.layer === layer && existing.ciType === ci.type) return toAsset(existing);
    const moved = await tx.assetRecord.update({
      where: { id: existing.id },
      data: { layer, ciType: ci.type },
    });
    await tx.assetAudit.create({
      data: {
        tenantId,
        assetId: existing.id,
        actor,
        at: new Date(at),
        field: 'layer',
        fromValue: existing.layer,
        toValue: layer,
        note: 'labelled as ' + ci.type,
      },
    });
    return toAsset(moved);
  }
  const fields = assetFieldsFromCi(ci.type, ci.attributes, ci.observedAt);
  const when = new Date(at);
  const currency = ci.attributes['currency'];
  const row = await tx.assetRecord.create({
    data: {
      tenantId,
      ciId: ci.id,
      ciType: ci.type,
      layer,
      source: 'discovery',
      assetTag: fields.assetTag ?? ci.code,
      serialNumber: fields.serialNumber,
      manufacturer: fields.manufacturer,
      model: fields.model,
      partNumber: fields.partNumber,
      stage: 'deployed',
      stageChangedAt: when,
      purchasedAt: fields.purchasedAt === null ? null : new Date(fields.purchasedAt),
      depreciationMethod: 'none',
      usefulLifeMonths: ASSETS.defaultUsefulLifeMonths,
      residualValueAmount: 0,
      residualValueCurrency:
        typeof currency === 'string' && currency.length === MONEY.currencyCodeLength
          ? currency
          : MONEY.noCurrency,
      warranty: fields.warranty ?? Prisma.DbNull,
      subscription: fields.subscription ?? Prisma.DbNull,
      support: fields.support ?? Prisma.DbNull,
      tags: [],
      customFields: {},
    },
  });
  await tx.assetAudit.create({
    data: {
      tenantId,
      assetId: row.id,
      actor,
      at: when,
      field: 'stage',
      fromValue: null,
      toValue: 'deployed',
      note: 'created when the CI was labelled as ' + ci.type,
    },
  });
  return toAsset(row);
}
