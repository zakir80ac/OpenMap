// REQ-CORE-001 REQ-CMDB-039 — asset management contract: lifecycle, purchasing, warranty, support, end of life,
// support contracts and vendor contacts. An asset record attaches to an owned CI by ciId (ADR-023): the register
// holds every CI of an owned type, the planned assets of a plan's BOM, and assets entered by hand.
import { z } from 'zod';
import { CI_TYPES, ciLayerSchema, ciTypeSchema, type CiType } from './ci.js';

/** Asset lifecycle stages. An asset is in exactly one; every move is audited. `planned` assets come from an infrastructure plan's BOM. */
export const ASSET_STAGES = [
  'planned',
  'in_stock',
  'deployed',
  'spare',
  'rma',
  'retired',
  'disposed',
] as const;
export const assetStageSchema = z.enum(ASSET_STAGES);
export type AssetStage = z.infer<typeof assetStageSchema>;

/**
 * Where an asset record came from (ADR-023): `plan` rows are a plan's BOM, `discovery` rows are created by the
 * reconciler for every CI of an owned type, `manual` rows are entered by hand for items with no network presence.
 */
export const ASSET_SOURCES = ['plan', 'discovery', 'manual'] as const;
export const assetSourceSchema = z.enum(ASSET_SOURCES);
export type AssetSource = z.infer<typeof assetSourceSchema>;

/**
 * CI types the organisation owns, licenses or subscribes to and therefore tracks as assets with warranty, support
 * and end-of-life dates. Everything else in the CMDB (addresses, interfaces, records, rules, workloads, sites,
 * accounts, vendors) is topology or context, not property. Order follows CI_TYPES.
 */
export const OWNED_CI_TYPES = [
  'host',
  'chassis',
  'blade',
  'bmc',
  'hypervisor',
  'vm_cluster',
  'vm',
  'operating_system',
  'k8s_cluster',
  'network_device',
  'load_balancer',
  'storage_array',
  'fc_switch',
  'database',
  'database_cluster',
  'certificate',
  'application',
  'software',
  'software_instance',
  'licence',
  'rack',
  'pdu',
  'ups',
  'cooling_unit',
  'patch_panel',
  'cloud_account',
  'cloud_resource',
  'saas_application',
  'saas_tenant',
] as const satisfies readonly CiType[];
export type OwnedCiType = (typeof OWNED_CI_TYPES)[number];
const OWNED = new Set<string>(OWNED_CI_TYPES);
export function isOwnedCiType(type: string): type is OwnedCiType {
  return OWNED.has(type) && (CI_TYPES as readonly string[]).includes(type);
}

/**
 * The dates every asset must carry; a null one is a data gap the register flags for manual entry. Hardware carries a
 * warranty; software, SaaS and cloud services carry a subscription instead (REQ-CMDB-042, ADR-027).
 */
export const ASSET_DATA_GAPS = ['warranty', 'subscription', 'support', 'end_of_life'] as const;
export const assetDataGapSchema = z.enum(ASSET_DATA_GAPS);
export type AssetDataGap = z.infer<typeof assetDataGapSchema>;

/** CI types whose cover is a subscription (start, end, credits) rather than a warranty. */
export const SUBSCRIPTION_CI_TYPES = [
  'software',
  'software_instance',
  'licence',
  'saas_application',
  'saas_tenant',
  'cloud_account',
  'cloud_resource',
] as const;
const SUBSCRIPTION_CI_TYPE_SET: ReadonlySet<string> = new Set(SUBSCRIPTION_CI_TYPES);
export function isSubscriptionCiType(type: string | null | undefined): boolean {
  return type !== null && type !== undefined && SUBSCRIPTION_CI_TYPE_SET.has(type);
}

/** ISO 4217 currency code. */
const currency = z.string().length(3);
const money = z.object({ amount: z.number().min(0), currency });

export const vendorContactSchema = z.object({
  id: z.uuid(),
  tenantId: z.uuid(),
  vendorCiId: z.uuid(),
  name: z.string().min(1),
  role: z.string().min(1),
  email: z.string().email().nullable(),
  phone: z.string().nullable(),
  portalUrl: z.string().nullable(),
  /** Hours and time zone in which this contact may be reached, free text. */
  availability: z.string().nullable(),
  escalationLevel: z.number().int().min(1),
});
export type VendorContact = z.infer<typeof vendorContactSchema>;

export const SUPPORT_LEVELS = [
  'none',
  'basic',
  'next_business_day',
  'four_hour',
  'mission_critical',
  'custom',
] as const;

export const supportContractSchema = z.object({
  id: z.uuid(),
  tenantId: z.uuid(),
  vendorCiId: z.uuid(),
  contractNumber: z.string().min(1),
  title: z.string().min(1),
  level: z.enum(SUPPORT_LEVELS),
  /** Response time commitment in minutes for the highest severity. */
  responseMinutes: z.number().int().positive().nullable(),
  startsAt: z.iso.date(),
  endsAt: z.iso.date(),
  autoRenews: z.boolean(),
  annualCost: money.nullable(),
  costCentreCiId: z.uuid().nullable(),
  primaryContactId: z.uuid().nullable(),
  /** External identifiers in vendor systems (Dell TechDirect, Cisco SNTC, HPE). */
  externalIds: z.array(z.object({ source: z.string().min(1), id: z.string().min(1) })),
  documentRefs: z.array(z.string()),
});
export type SupportContract = z.infer<typeof supportContractSchema>;

export const DATE_SOURCES = ['vendor_api', 'purchase_record', 'manual'] as const;
export const dateSourceSchema = z.enum(DATE_SOURCES);
export type DateSource = z.infer<typeof dateSourceSchema>;

export const warrantySchema = z.object({
  provider: z.string().min(1),
  /** Service level as the vendor names it; null when the collector saw only the end date. */
  level: z.string().min(1).nullable(),
  /** Null when only the end date is known (a vendor API or a label reports the expiry alone). */
  startsAt: z.iso.date().nullable(),
  endsAt: z.iso.date(),
  /** Where the dates came from: vendor API, invoice, manual. */
  source: dateSourceSchema,
  verifiedAt: z.iso.datetime().nullable(),
});
export type Warranty = z.infer<typeof warrantySchema>;

/** Vendor support cover entered on the asset itself; a SupportContract row (supportContractId) is the other way. */
export const supportSchema = z.object({
  provider: z.string().min(1),
  contractNumber: z.string().min(1).nullable(),
  level: z.string().min(1).nullable(),
  endsAt: z.iso.date(),
  source: dateSourceSchema,
  verifiedAt: z.iso.datetime().nullable(),
});
export type Support = z.infer<typeof supportSchema>;

/** Remaining prepaid credits of a cloud or SaaS subscription, as the vendor's billing API reported them. */
export const creditsSchema = z.object({
  remaining: z.number().min(0),
  /** What the number counts: a currency amount, vendor credits, seats, hours. */
  unit: z.string().min(1),
  currency: z.string().length(3).nullable(),
  asOf: z.iso.datetime(),
});
export type Credits = z.infer<typeof creditsSchema>;

/**
 * Subscription cover of software, SaaS and cloud assets (ADR-027): the term and the credits left. Either an end date
 * or a credit balance must be known for the cover to count; the rest stays null until the vendor or a person reports it.
 */
export const subscriptionSchema = z
  .object({
    provider: z.string().min(1),
    /** Plan, SKU or edition as the vendor names it. */
    plan: z.string().min(1).nullable(),
    startsAt: z.iso.date().nullable(),
    endsAt: z.iso.date().nullable(),
    credits: creditsSchema.nullable(),
    source: dateSourceSchema,
    verifiedAt: z.iso.datetime().nullable(),
  })
  .refine((v) => v.endsAt !== null || v.credits !== null, {
    message: 'a subscription needs an end date or a credit balance',
  });
export type Subscription = z.infer<typeof subscriptionSchema>;

export const endOfLifeSchema = z.object({
  endOfSale: z.iso.date().nullable(),
  endOfSoftwareMaintenance: z.iso.date().nullable(),
  endOfSupport: z.iso.date().nullable(),
  source: z.string().min(1),
  verifiedAt: z.iso.datetime().nullable(),
});
export type EndOfLife = z.infer<typeof endOfLifeSchema>;

/**
 * The data gaps of an asset: each of the three dates that is missing. A subscription type is asked for its
 * subscription, every other type for its warranty; both are asked for support and end of life.
 */
export function assetDataGaps(asset: {
  ciType?: string | null | undefined;
  warranty: unknown;
  subscription?: unknown;
  support: unknown;
  supportContractId: string | null;
  endOfLife: { endOfSupport: string | null } | null;
}): AssetDataGap[] {
  const gaps: AssetDataGap[] = [];
  if (isSubscriptionCiType(asset.ciType)) {
    if (asset.subscription === null || asset.subscription === undefined) gaps.push('subscription');
  } else if (asset.warranty === null || asset.warranty === undefined) gaps.push('warranty');
  if ((asset.support === null || asset.support === undefined) && asset.supportContractId === null)
    gaps.push('support');
  if (asset.endOfLife === null || asset.endOfLife.endOfSupport === null) gaps.push('end_of_life');
  return gaps;
}

export const PLAN_KINDS = [
  'new_infrastructure',
  'stack_expansion',
  'refresh',
  'migration',
  'decommission',
] as const;
export const PLAN_STATUSES = ['draft', 'approved', 'building', 'live', 'cancelled'] as const;

/** One line of a plan's bill of materials. Each line becomes `quantity` assets in stage `planned`. */
export const bomLineSchema = z.object({
  description: z.string().min(1),
  manufacturer: z.string().nullable(),
  model: z.string().nullable(),
  sku: z.string().nullable(),
  /** Layer the resulting CIs will live in (CI_LAYERS from ci.ts). */
  layer: z.string().min(1),
  quantity: z.number().int().positive(),
  received: z.number().int().min(0),
  unitCost: money.nullable(),
  vendorCiId: z.uuid().nullable(),
});

/**
 * Infrastructure plan: "plan for new infra or stack and enter the details". Replaces purchase
 * orders; procurement happens in the finance system and is linked by reference only.
 */
export const infraPlanSchema = z.object({
  id: z.uuid(),
  tenantId: z.uuid(),
  number: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  kind: z.enum(PLAN_KINDS),
  status: z.enum(PLAN_STATUSES),
  owner: z.string().min(1),
  targetSiteCiId: z.uuid().nullable(),
  targetRackCiIds: z.array(z.uuid()),
  costCentreCiId: z.uuid().nullable(),
  bom: z.array(bomLineSchema).min(1),
  estimatedCost: money.nullable(),
  /** External procurement references (ERP order numbers, quotes), never managed here. */
  externalRefs: z.array(z.object({ source: z.string().min(1), id: z.string().min(1) })),
  plannedLiveAt: z.iso.date().nullable(),
  /** Asset records created from this plan's BOM. */
  assetIds: z.array(z.uuid()),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type InfraPlan = z.infer<typeof infraPlanSchema>;

export const DEPRECIATION_METHODS = ['straight_line', 'declining_balance', 'none'] as const;
export type DepreciationMethod = (typeof DEPRECIATION_METHODS)[number];

export const assetRecordSchema = z.object({
  id: z.uuid(),
  tenantId: z.uuid(),
  /** The CI this asset record describes; null while planned and not yet discovered. */
  ciId: z.uuid().nullable(),
  /** The CI's type at creation, kept so a register row can be grouped without the CI. */
  ciType: ciTypeSchema.nullable(),
  /** Layer of the register the asset lists under: the CI's layer, the BOM line's layer, or the manual choice. */
  layer: ciLayerSchema,
  source: assetSourceSchema,
  assetTag: z.string().min(1),
  serialNumber: z.string().nullable(),
  /** Null when neither discovery nor a person has recorded it: a software instance or a cloud resource has none. */
  manufacturer: z.string().min(1).nullable(),
  model: z.string().min(1).nullable(),
  partNumber: z.string().nullable(),
  stage: assetStageSchema,
  stageChangedAt: z.iso.datetime(),
  /** Physical location when not deployed in a rack: a room or storage CI. */
  locationCiId: z.uuid().nullable(),
  custodian: z.string().nullable(),
  ownerCostCentreCiId: z.uuid().nullable(),
  /** The plan whose BOM created this asset; null for assets discovered or imported directly. */
  planId: z.uuid().nullable(),
  /** ADR-034: the BOM line of that plan this unit belongs to. */
  bomLineId: z.uuid().nullable(),
  purchasedAt: z.iso.date().nullable(),
  purchaseCost: money.nullable(),
  depreciation: z.object({
    method: z.enum(DEPRECIATION_METHODS),
    usefulLifeMonths: z.number().int().positive(),
    residualValue: money,
  }),
  warranty: warrantySchema.nullable(),
  /** ADR-027: the subscription term and credits of software, SaaS and cloud assets. */
  subscription: subscriptionSchema.nullable(),
  support: supportSchema.nullable(),
  supportContractId: z.uuid().nullable(),
  endOfLife: endOfLifeSchema.nullable(),
  /** Spare-part stock control; null for non-stocked assets. */
  stock: z.object({ onHand: z.number().int().min(0), reorderPoint: z.number().int().min(0) }).nullable(),
  tags: z.array(z.string().min(1)),
  customFields: z.record(z.string().min(1), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type AssetRecord = z.infer<typeof assetRecordSchema>;

/** Append-only audit entry written on every stage change or field edit. */
export const assetAuditSchema = z.object({
  id: z.uuid(),
  assetId: z.uuid(),
  actor: z.string().min(1),
  at: z.iso.datetime(),
  field: z.string().min(1),
  from: z.string().nullable(),
  to: z.string().nullable(),
  note: z.string().nullable(),
});
export type AssetAudit = z.infer<typeof assetAuditSchema>;

/**
 * The register fields a CI's observed attributes already carry (ADR-023). The same mapping runs in Postgres for the
 * one-off backfill (migration 0015) and here for every CI the reconciler creates or updates, and when a person
 * labels an unknown CI into an owned type. Values are taken as the collectors report them; nothing is invented, so a
 * field the attributes lack stays null and shows as a data gap.
 */
export interface AssetFieldsFromCi {
  assetTag: string | null;
  serialNumber: string | null;
  manufacturer: string | null;
  model: string | null;
  partNumber: string | null;
  purchasedAt: string | null;
  warranty: Warranty | null;
  subscription: Subscription | null;
  support: Support | null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;
/** Types whose `expiresAt` is a subscription or entitlement end, recorded as support cover. */
const SUBSCRIPTION_TYPES: ReadonlySet<string> = new Set([
  'licence',
  'saas_application',
  'saas_tenant',
  'certificate',
]);

function text(attributes: Record<string, unknown>, ...keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = attributes[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return null;
}

function isoDate(attributes: Record<string, unknown>, key: string): string | null {
  const value = text(attributes, key);
  return value !== null && ISO_DATE.test(value) ? value : null;
}

/** A calendar date from a date or an instant attribute (collectors report RFC 3339 for SaaS and cloud terms). */
function calendarDate(attributes: Record<string, unknown>, ...keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = text(attributes, key);
    if (value === null) continue;
    if (ISO_DATE.test(value)) return value;
    const ms = Date.parse(value);
    if (!Number.isNaN(ms)) return new Date(ms).toISOString().slice(0, ISO_DATE_LENGTH);
  }
  return null;
}
const ISO_DATE_LENGTH = 'YYYY-MM-DD'.length;

function number(attributes: Record<string, unknown>, key: string): number | null {
  const value = attributes[key];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Attribute names a collector or the synthetic estate uses for subscription terms and credits (ADR-027). */
export const SUBSCRIPTION_ATTRIBUTES = {
  start: ['subscriptionStart', 'activatedAt', 'purchaseDate'],
  end: ['subscriptionEnd', 'expiresAt', 'nextLifecycleDateTime'],
  plan: ['plan', 'licenceType', 'sku', 'edition'],
  creditsRemaining: 'creditsRemaining',
  creditsUnit: 'creditsUnit',
  creditsCurrency: 'creditsCurrency',
  creditsAsOf: 'creditsAsOf',
  defaultCreditsUnit: 'credits',
} as const;

/** The subscription a subscription-type CI's attributes describe, or null when neither a term end nor credits are known. */
export function subscriptionFromAttributes(
  type: string,
  attributes: Record<string, unknown>,
  observedAt: string | null = null,
): Subscription | null {
  if (!isSubscriptionCiType(type)) return null;
  const provider = text(attributes, 'vendor', 'provider', 'manufacturer');
  if (provider === null) return null;
  const endsAt = calendarDate(attributes, ...SUBSCRIPTION_ATTRIBUTES.end);
  const remaining = number(attributes, SUBSCRIPTION_ATTRIBUTES.creditsRemaining);
  const asOf = text(attributes, SUBSCRIPTION_ATTRIBUTES.creditsAsOf) ?? observedAt;
  const credits: Credits | null =
    remaining !== null && asOf !== null && !Number.isNaN(Date.parse(asOf))
      ? {
          remaining,
          unit:
            text(attributes, SUBSCRIPTION_ATTRIBUTES.creditsUnit) ??
            SUBSCRIPTION_ATTRIBUTES.defaultCreditsUnit,
          currency: text(attributes, SUBSCRIPTION_ATTRIBUTES.creditsCurrency),
          asOf: new Date(asOf).toISOString(),
        }
      : null;
  if (endsAt === null && credits === null) return null;
  return {
    provider,
    plan: text(attributes, ...SUBSCRIPTION_ATTRIBUTES.plan),
    startsAt: calendarDate(attributes, ...SUBSCRIPTION_ATTRIBUTES.start),
    endsAt,
    credits,
    source: 'vendor_api',
    verifiedAt: null,
  };
}

export function assetFieldsFromCi(
  type: string,
  attributes: Record<string, unknown>,
  observedAt: string | null = null,
): AssetFieldsFromCi {
  const manufacturer = text(attributes, 'manufacturer', 'vendor');
  const warrantyEnd = isoDate(attributes, 'warrantyEnd');
  const warrantyProvider = text(attributes, 'warrantyProvider') ?? manufacturer;
  const expiresAt = isoDate(attributes, 'expiresAt');
  const vendor = text(attributes, 'vendor');
  return {
    assetTag: text(attributes, 'assetTag'),
    serialNumber: text(attributes, 'serialNumber'),
    manufacturer,
    model: text(attributes, 'model', 'product', 'software', 'name', 'sku', 'resourceType'),
    partNumber: text(attributes, 'partNumber', 'sku'),
    purchasedAt: isoDate(attributes, 'purchaseDate'),
    warranty:
      warrantyEnd !== null && warrantyProvider !== null
        ? {
            provider: warrantyProvider,
            level: text(attributes, 'warrantyLevel'),
            startsAt: isoDate(attributes, 'purchaseDate'),
            endsAt: warrantyEnd,
            source: 'vendor_api',
            verifiedAt: null,
          }
        : null,
    subscription: subscriptionFromAttributes(type, attributes, observedAt),
    support:
      SUBSCRIPTION_TYPES.has(type) && expiresAt !== null && vendor !== null
        ? {
            provider: vendor,
            contractNumber: text(attributes, 'poNumber'),
            level: text(attributes, 'licenceType'),
            endsAt: expiresAt,
            source: 'vendor_api',
            verifiedAt: null,
          }
        : null,
  };
}

/** REQ-CMDB-017 — what an asset's value is on a day, under its depreciation schedule. */
export interface DepreciationSchedule {
  method: DepreciationMethod;
  usefulLifeMonths: number;
  residualValue: number;
}

/** Whole calendar months between a purchase date and a day (YYYY-MM-DD or ISO), never negative. */
export function monthsBetween(from: string, to: string): number {
  const a = new Date(from);
  const b = new Date(to);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime()) || b < a) return 0;
  const months = (b.getUTCFullYear() - a.getUTCFullYear()) * MONTHS_PER_YEAR + (b.getUTCMonth() - a.getUTCMonth());
  return b.getUTCDate() < a.getUTCDate() ? Math.max(0, months - 1) : months;
}

const MONTHS_PER_YEAR = 12;
/** Double-declining balance: twice the straight-line rate, applied to what is left each month. */
const DECLINING_FACTOR = 2;

/**
 * The book value on `asOf`: straight line spreads (cost − residual) evenly over the useful life; declining balance
 * takes twice the straight-line rate of what is left each month; both stop at the residual value; `none` keeps the
 * cost. Rounded to cents. Null without a cost or a purchase date.
 */
export function bookValue(cost: number | null, purchasedAt: string | null, schedule: DepreciationSchedule, asOf: string): number | null {
  if (cost === null || purchasedAt === null) return null;
  const residual = Math.min(schedule.residualValue, cost);
  const months = Math.min(monthsBetween(purchasedAt, asOf), schedule.usefulLifeMonths);
  let value: number;
  switch (schedule.method) {
    case 'none':
      value = cost;
      break;
    case 'straight_line':
      value = cost - ((cost - residual) * months) / schedule.usefulLifeMonths;
      break;
    case 'declining_balance':
      value = months >= schedule.usefulLifeMonths ? residual : Math.max(residual, cost * (1 - DECLINING_FACTOR / schedule.usefulLifeMonths) ** months);
      break;
  }
  return Math.round(value * CENTS) / CENTS;
}

const CENTS = 100;

/** REQ-CMDB-019 — a stocked spare is low when what is on hand has fallen to its reorder point. */
export function belowReorderPoint(stock: { onHand: number; reorderPoint: number } | null): boolean {
  return stock !== null && stock.onHand <= stock.reorderPoint;
}

/** ADR-034 — a plan takes deliveries once approved; the first receipt moves an approved plan to building. */
export const PLAN_RECEIVING_STATUSES = ['approved', 'building'] as const;

export function canReceive(status: string): boolean {
  return (PLAN_RECEIVING_STATUSES as readonly string[]).includes(status);
}

/** Units of a BOM line not yet received. */
export function outstanding(line: { quantity: number; received: number }): number {
  return Math.max(0, line.quantity - line.received);
}

/** One unit taken into stock: its serial and, when the organisation labels on arrival, its asset tag. */
export const receivedUnitSchema = z.object({
  serialNumber: z.string().trim().min(1),
  assetTag: z.string().trim().min(1).nullable(),
});
export type ReceivedUnit = z.infer<typeof receivedUnitSchema>;

/** REQ-CMDB-020 — goods received against one BOM line (ADR-034). */
export const planReceiptSchema = z.object({
  id: z.uuid(),
  tenantId: z.uuid(),
  planId: z.uuid(),
  bomLineId: z.uuid(),
  /** Position of the line in the plan's BOM, from 0. */
  position: z.number().int().min(0),
  quantity: z.number().int().positive(),
  receivedOn: z.iso.date(),
  receivedBy: z.string().min(1),
  /** ERP order or delivery note number; procurement stays in the finance system (ADR-005). */
  reference: z.string().min(1).nullable(),
  locationCiId: z.uuid().nullable(),
  assetIds: z.array(z.uuid()).min(1),
  createdAt: z.iso.datetime(),
});
export type PlanReceipt = z.infer<typeof planReceiptSchema>;

const LINE_BREAK = /\r?\n/;
/** A comma or a tab separates a unit's serial from its tag (a scanner or a spreadsheet column paste). */
const UNIT_FIELD_SEPARATOR = /[,\t]/;

export type ReceivedUnitsProblem =
  | { kind: 'empty' }
  | { kind: 'too_many'; count: number; outstanding: number }
  | { kind: 'duplicate'; serialNumber: string };

/**
 * Reads the units a person types or scans when goods arrive: one per line, the serial first and an optional asset tag
 * after a comma or a tab. Blank lines are skipped; a serial may appear once, and no more units than are outstanding.
 */
export function parseReceivedUnits(
  text: string,
  outstandingUnits: number,
): { units: ReceivedUnit[]; problem: ReceivedUnitsProblem | null } {
  const units: ReceivedUnit[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(LINE_BREAK)) {
    const [serialPart = '', tagPart = ''] = raw.split(UNIT_FIELD_SEPARATOR, 2);
    const serialNumber = serialPart.trim();
    if (serialNumber === '') continue;
    if (seen.has(serialNumber)) return { units, problem: { kind: 'duplicate', serialNumber } };
    seen.add(serialNumber);
    const tag = tagPart.trim();
    units.push({ serialNumber, assetTag: tag === '' ? null : tag });
  }
  if (units.length === 0) return { units, problem: { kind: 'empty' } };
  if (units.length > outstandingUnits)
    return { units, problem: { kind: 'too_many', count: units.length, outstanding: outstandingUnits } };
  return { units, problem: null };
}
